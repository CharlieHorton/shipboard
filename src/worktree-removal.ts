/** Guarded removal of one registered checkout. Never fetches or deletes a branch. */
import { isAbsolute, resolve } from "node:path";
import { findRepo, projectForRepo } from "./config.js";
import type { Db } from "./db.js";
import { expandHome } from "./eas.js";
import { worktreeStage } from "./stage.js";
import * as store from "./store.js";
import type { Config, WorktreeRow } from "./types.js";
import { gitClient, type GitClient, type GitResult } from "./worktrees.js";

export class WorktreeRemovalError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 500, message: string) {
    super(message);
    this.name = "WorktreeRemovalError";
  }
}

const isSha = (value: string): boolean => /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value);
const refuse = (message: string): never => { throw new WorktreeRemovalError(409, message); };

interface Registration { path: string; head: string; branch: string; unsafe: boolean }

/** NUL mode preserves exact whitespace and quoted characters in paths. */
function registrations(output: string): Registration[] {
  if (!output.endsWith("\0\0")) return refuse("Git returned an incomplete worktree listing. Refresh before retrying.");
  return output.slice(0, -2).split("\0\0").map((block) => {
    const fields = block.split("\0");
    const first = fields.shift();
    if (!first?.startsWith("worktree ")) return refuse("Git returned an invalid worktree registration.");
    const row: Registration = { path: first.slice(9), head: "", branch: "", unsafe: false };
    const seen = new Set<string>();
    for (const field of fields) {
      const space = field.indexOf(" ");
      const key = space < 0 ? field : field.slice(0, space);
      const value = space < 0 ? "" : field.slice(space + 1);
      if (seen.has(key)) return refuse("Git returned an ambiguous worktree registration.");
      seen.add(key);
      if (key === "HEAD") row.head = value;
      else if (key === "branch" && value.startsWith("refs/heads/")) row.branch = value.slice(11);
      else if (["locked", "prunable", "detached", "bare"].includes(key)) row.unsafe = true;
      else return refuse("Git returned an unknown worktree registration field.");
    }
    if (!isAbsolute(row.path)) return refuse("Git returned a non-absolute worktree path.");
    return row;
  });
}

/** The caller serializes removal requests for the same path. All git I/O is injectable. */
export async function removeWorktree(
  db: Db,
  cfg: Config,
  input: { path: string; expected_head: string },
  git: GitClient = gitClient,
): Promise<void> {
  if (typeof input.path !== "string" || !isAbsolute(input.path) || input.path.includes("\0") ||
      typeof input.expected_head !== "string" || !isSha(input.expected_head)) {
    throw new WorktreeRemovalError(400, "An exact absolute worktree path and full expected commit are required.");
  }
  const cached = db.prepare(`SELECT * FROM worktrees WHERE path = ?`).get(input.path) as WorktreeRow | undefined;
  if (!cached) throw new WorktreeRemovalError(404, "This worktree is not in the cache. Refresh the dashboard.");
  const repo = findRepo(cfg, cached.repo);
  if (!repo?.local) return refuse("The worktree has no configured owning checkout.");
  const main = expandHome(repo.local);
  if (!isAbsolute(main)) return refuse("The owning checkout must have an absolute configured path.");
  const linkedPr = store.findPrByBranch(db, cached.repo, cached.branch);
  const cachedStage = worktreeStage(cached, linkedPr);
  if (cached.is_main || resolve(cached.path) === resolve(main)) return refuse("The main checkout cannot be removed.");
  if (cached.head_sha !== input.expected_head) return refuse("The cached commit changed. Refresh and review this worktree again.");
  if (!cached.branch || cached.dirty !== 0 || cached.unpushed !== 0 || cached.ahead_of_dev < 0 ||
      !["empty", "merged"].includes(cachedStage)) return refuse("This checkout is not a known clean cleanup candidate.");

  const run = async (cwd: string, args: string[]): Promise<GitResult> => {
    try {
      const result = await git.run(cwd, args);
      if (!Number.isInteger(result.code) || typeof result.stdout !== "string") return refuse("Git returned an unknown result; removal was stopped.");
      return result;
    } catch (err) {
      if (err instanceof WorktreeRemovalError) throw err;
      return refuse("Git could not verify this checkout. Inspect it locally before retrying.");
    }
  };
  const checked = async (cwd: string, args: string[], message: string): Promise<string> => {
    const result = await run(cwd, args);
    if (result.code !== 0) return refuse(message);
    return result.stdout;
  };
  const listed = registrations(await checked(main, ["worktree", "list", "--porcelain", "-z"], "Git could not list the owning repository's worktrees."));
  if (listed[0]?.path === cached.path) return refuse("Git identifies this as the main checkout; it cannot be removed.");
  const matches = listed.filter((entry) => entry.path === cached.path);
  if (matches.length !== 1) return refuse("The exact worktree registration is missing or ambiguous. Refresh the dashboard.");
  const entry = matches[0]!;
  if (entry.unsafe) return refuse("Locked, prunable, detached, or bare worktrees cannot be removed here.");
  if (entry.head !== input.expected_head || entry.branch !== cached.branch) return refuse("The registered branch or commit changed. Refresh and review it again.");

  const localBranch = `refs/heads/${cached.branch}`;
  const devRef = `refs/remotes/origin/${repo.dev_branch}`;
  const remoteBranch = `refs/remotes/origin/${cached.branch}`;
  const verifyRef = async (cwd: string, ref: string): Promise<string> => {
    const value = (await checked(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      `Could not verify ${ref}; removal was stopped.`)).trim();
    if (!isSha(value)) return refuse(`Git returned an unknown commit for ${ref}.`);
    return value;
  };
  const inspectIdentityAndStatus = async (): Promise<void> => {
    if (await verifyRef(cached.path, "HEAD") !== input.expected_head) return refuse("The checkout HEAD changed. Refresh and review it again.");
    const branch = (await checked(cached.path, ["symbolic-ref", "--quiet", "HEAD"], "The checkout is detached or its branch is unavailable.")).trim();
    if (branch !== localBranch) return refuse("The checkout branch changed. Refresh and review it again.");
    if (await verifyRef(main, localBranch) !== input.expected_head) return refuse("The local branch no longer preserves this commit; removal was stopped.");
    const status = await checked(cached.path, ["status", "--porcelain", "--untracked-files=all"], "Git could not check for local changes.");
    if (status !== "") return refuse("The checkout has modified or untracked files. Preserve them before removing it.");
  };
  await inspectIdentityAndStatus();
  await verifyRef(main, devRef);
  const remote = await run(main, ["rev-parse", "--verify", "-q", `${remoteBranch}^{commit}`]);
  if (remote.code !== 0 && remote.code !== 1) return refuse("The remote branch state is unknown.");
  if (remote.code === 0 && !isSha(remote.stdout.trim())) return refuse("The remote branch commit is unknown.");
  const count = async (args: string[]): Promise<number> => {
    const text = (await checked(cached.path, ["rev-list", "--count", ...args], "Git could not compare local commits with the cached remote refs.")).trim();
    const n = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(n)) return refuse("Git returned an unknown commit count.");
    return n;
  };
  const ahead = await count(["HEAD", `^${devRef}`]);
  const unpushed = remote.code === 0 ? await count(["HEAD", `^${devRef}`, `^${remoteBranch}`]) : ahead;
  if (unpushed !== 0) return refuse("The checkout contains commits absent from the cached remote refs. Preserve them before removing it.");
  const freshStage = worktreeStage({ ...cached, ahead_of_dev: ahead, unpushed, dirty: 0 }, linkedPr);
  if (!["empty", "merged"].includes(freshStage)) return refuse("The checkout is no longer a cleanup candidate.");

  // Recheck immediately before Git's own no-force dirty/lock protection runs.
  await inspectIdentityAndStatus();
  // Sync/PR linking can update the cache while the read-only git calls await.
  // Revalidate that the user's reviewed candidate still exists and is eligible.
  const latest = db.prepare(`SELECT * FROM worktrees WHERE path = ?`).get(cached.path) as WorktreeRow | undefined;
  const latestPr = store.findPrByBranch(db, cached.repo, cached.branch);
  if (!latest || latest.repo !== cached.repo || latest.branch !== cached.branch || latest.head_sha !== input.expected_head ||
      latest.is_main || latest.dirty !== 0 || latest.unpushed !== 0 || latest.ahead_of_dev < 0 ||
      !["empty", "merged"].includes(worktreeStage(latest, latestPr))) {
    return refuse("The cached worktree or pull request changed during verification. Refresh and review it again.");
  }
  const removed = await run(main, ["worktree", "remove", "--", cached.path]);
  if (removed.code !== 0) throw new WorktreeRemovalError(500,
    "Git could not remove the checkout. The cached entry was retained; inspect the checkout before retrying. No force or branch deletion was requested.");

  const itemIds = new Set<number>();
  if (latestPr?.item_id != null) itemIds.add(latestPr.item_id);
  const project = projectForRepo(cfg, cached.repo);
  if (cached.silo && project !== undefined) for (const item of store.listItems(db, { project })) {
    if (item.silo === cached.silo) itemIds.add(item.id);
  }
  db.transaction(() => {
    db.prepare(`DELETE FROM worktrees WHERE path = ?`).run(cached.path);
    for (const id of itemIds) store.addEvent(db, id, "user", `Removed worktree ${cached.path}; retained branch ${cached.branch} at ${input.expected_head}`);
  })();
}

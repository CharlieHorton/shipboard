/**
 * Local git worktree tracking: the working copies on this machine → the
 * `worktrees` table.
 *
 * GitHub knows nothing about a branch that was never pushed, and the user works
 * in "silos" — one worktree per repo under `~/Projects/<x>-features/<silo>/`,
 * plus the odd `<checkout>/.claude/worktrees/<name>`. Branches get forgotten
 * there: commits that exist only on this laptop, pushed branches with no PR,
 * worktrees left behind after their PR merged. Sync records all of it so
 * `stage.ts` can rank a local branch alongside the PRs of the same item.
 *
 * Everything here is derived and disposable: a worktree that vanishes from
 * `git worktree list` loses its row on the next sync. Nothing throws — a
 * missing checkout, an offline fetch or an unreadable worktree degrades to
 * "less information", never to a failed sync.
 */

import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { expandHome } from "./eas.js";
import type { RepoConfig, WorktreeRow } from "./types.js";
import { repoKey } from "./types.js";

const execFileAsync = promisify(execFile);

/** A worktree listing on a busy repo is a few KB; a status can be larger. */
const MAX_BUFFER = 8 * 1024 * 1024;

/** Worktrees are refreshed in parallel; each one costs ~4 cheap git calls. */
const WORKTREE_CONCURRENCY = 4;

// ---------- git client ----------

export interface GitResult {
  /** Process exit code. Non-zero is normal for the "does this ref exist?" probe. */
  code: number;
  stdout: string;
}

/**
 * Everything worktree sync needs from git. `gitClient` is the real thing;
 * tests inject a fake so no test spawns a process or touches a real checkout.
 */
export interface GitClient {
  /** Run `git <args>` in `cwd`. Never rejects: a failure is a non-zero `code`. */
  run(cwd: string, args: string[]): Promise<GitResult>;
}

export const gitClient: GitClient = {
  async run(cwd, args) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
      return { code: 0, stdout };
    } catch (err) {
      // execFile rejects on a non-zero exit and on a missing/unreadable cwd;
      // both are ordinary here, so they come back as a result, not a throw.
      const e = err as { code?: unknown; stdout?: unknown };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: typeof e.stdout === "string" ? e.stdout : "",
      };
    }
  },
};

// ---------- parsing ----------

/** One usable worktree from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path, as git printed it. */
  path: string;
  head: string;
  /** Short branch name: "refs/heads/feature/sample-feature" → "feature/sample-feature". */
  branch: string;
}

const HEADS_PREFIX = "refs/heads/";

/**
 * Parse `git worktree list --porcelain`.
 *
 * Blocks are separated by blank lines and start with `worktree <abs path>`,
 * followed by `HEAD <sha>` and either `branch <ref>` or a bare `detached`.
 * `bare`, `locked` and `prunable` lines may appear anywhere in a block.
 *
 * Detached and bare entries are dropped: neither has a branch, so there is
 * nothing to compare against origin and nothing to open a PR for. The first
 * block is the repo's main checkout; callers decide what that means.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: { path: string; head: string; branch: string; usable: boolean } | undefined;

  const flush = (): void => {
    if (cur && cur.usable && cur.path !== "" && cur.branch !== "") {
      out.push({ path: cur.path, head: cur.head, branch: cur.branch });
    }
    cur = undefined;
  };

  for (const raw of porcelain.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);

    if (key === "worktree") {
      flush();
      cur = { path: value, head: "", branch: "", usable: true };
      continue;
    }
    if (cur === undefined) continue; // stray line before any block
    if (key === "HEAD") cur.head = value;
    else if (key === "branch") {
      cur.branch = value.startsWith(HEADS_PREFIX) ? value.slice(HEADS_PREFIX.length) : value;
    } else if (key === "detached" || key === "bare") cur.usable = false;
  }
  flush();
  return out;
}

/**
 * Silo of a worktree path: the feature directory that groups one worktree per
 * repo. `~/Projects/example-features/sample-feature/API` → "sample-feature" (the leaf is
 * the repo name, so the silo is its parent), while
 * `<checkout>/.claude/worktrees/email-dark-mode` → "email-dark-mode".
 */
export function siloFor(path: string, local: string): string {
  const leaf = basename(path);
  return leaf === basename(local) ? basename(dirname(path)) : leaf;
}

// ---------- sync ----------

export interface WorktreeSyncResult {
  /** Worktrees written this run. */
  seen: number;
  errors: string[];
}

/** Unknown is distinct from zero: zero can otherwise suggest safe cleanup. */
function count(r: GitResult): number {
  const value = r.stdout.trim();
  const n = Number(value);
  return r.code === 0 && /^\d+$/.test(value) && Number.isSafeInteger(n) ? n : -1;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

const UPSERT_SQL = `
INSERT INTO worktrees (path, repo, branch, head_sha, silo, is_main, ahead_of_dev, unpushed,
                       on_origin, dirty, last_commit_at, seen_at)
VALUES (@path, @repo, @branch, @head_sha, @silo, @is_main, @ahead_of_dev, @unpushed,
        @on_origin, @dirty, @last_commit_at, @seen_at)
ON CONFLICT(path) DO UPDATE SET
  repo = excluded.repo,
  branch = excluded.branch,
  head_sha = excluded.head_sha,
  silo = excluded.silo,
  is_main = excluded.is_main,
  ahead_of_dev = excluded.ahead_of_dev,
  unpushed = excluded.unpushed,
  on_origin = excluded.on_origin,
  dirty = excluded.dirty,
  last_commit_at = excluded.last_commit_at,
  seen_at = excluded.seen_at`;

/**
 * Refresh one worktree's row.
 *
 * `unpushed` is the number that matters and the only one that needs care: a
 * rebased branch is hundreds of commits "ahead" of an outdated `origin/<branch>`
 * while really carrying two of its own, so the count excludes the dev branch as
 * well as the branch's own remote — `HEAD ^origin/develop ^origin/<branch>`.
 * With no remote branch at all, everything ahead of dev is unpushed.
 */
async function readWorktree(
  git: GitClient,
  entry: WorktreeEntry,
  repo: RepoConfig,
  local: string,
  seen_at: string,
  remoteFresh: boolean,
  errors: string[],
): Promise<WorktreeRow> {
  const cwd = entry.path;
  const dev = `origin/${repo.dev_branch}`;

  const status = await git.run(cwd, ["status", "--porcelain"]);
  let ahead_of_dev = -1;
  let unpushed = -1;
  let on_origin = false;
  let last_commit_at = "";

  if (status.code !== 0) {
    // Keep a listed worktree visible even if it is unreadable. Unknown values
    // prevent previously clean observations from becoming cleanup advice.
    errors.push(`${cwd}: local status unavailable (exit ${status.code})`);
  } else {
    ahead_of_dev = count(await git.run(cwd, ["rev-list", "--count", `${dev}..HEAD`]));
    const onOrigin = await git.run(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${entry.branch}`]);
    on_origin = onOrigin.code === 0;
    unpushed = on_origin
      ? count(await git.run(cwd, ["rev-list", "--count", "HEAD", `^${dev}`, `^origin/${entry.branch}`]))
      : onOrigin.code === 1 ? ahead_of_dev : -1;
    if (ahead_of_dev < 0 || unpushed < 0) errors.push(`${cwd}: commit comparison unavailable`);
    // A failed fetch leaves the baseline uncertain, even when local git calls
    // succeed. Never present these counts as current cleanup evidence.
    if (!remoteFresh) ahead_of_dev = unpushed = -1;
    const lastCommit = await git.run(cwd, ["log", "-1", "--format=%cI"]);
    last_commit_at = lastCommit.code === 0 ? lastCommit.stdout.trim() : "";
  }

  const is_main = resolve(entry.path) === resolve(local);
  return {
    path: entry.path,
    repo: repoKey(repo),
    branch: entry.branch,
    head_sha: entry.head,
    silo: is_main ? "" : siloFor(entry.path, local),
    is_main: is_main ? 1 : 0,
    ahead_of_dev,
    unpushed,
    on_origin: on_origin ? 1 : 0,
    dirty: status.code !== 0 ? -1 : status.stdout.trim() === "" ? 0 : 1,
    last_commit_at,
    seen_at,
  };
}

/** Retain paths but withdraw stale cleanup evidence after an incomplete scan. */
function invalidateWorktrees(db: Db, repo: string): void {
  db.prepare(`UPDATE worktrees SET ahead_of_dev = -1, unpushed = -1, dirty = -1 WHERE repo = ?`).run(repo);
}

/**
 * Refresh every worktree of one repo. No `repo.local` means no local tracking
 * and no work at all.
 *
 * One `fetch origin` runs first (1-3 s) so the origin/* refs the counts are
 * measured against are current; a failed fetch is recorded and the counts are
 * marked unknown. Rows whose path was not listed this
 * run are deleted: a worktree removed on disk disappears from the tracker.
 *
 * Never throws.
 */
export async function syncWorktrees(
  db: Db,
  repo: RepoConfig,
  git: GitClient = gitClient,
): Promise<WorktreeSyncResult> {
  const out: WorktreeSyncResult = { seen: 0, errors: [] };
  if (repo.local === undefined || repo.local === "") return out;
  const local = expandHome(repo.local);
  const key = repoKey(repo);

  try {
    const fetched = await git.run(local, ["fetch", "--quiet", "origin"]);
    // Non-fatal, but cached remote refs cannot establish current cleanup safety.
    if (fetched.code !== 0) out.errors.push(`fetch origin failed (exit ${fetched.code}); commit comparisons unavailable`);

    const listed = await git.run(local, ["worktree", "list", "--porcelain"]);
    if (listed.code !== 0) {
      out.errors.push(`worktree list failed in ${local} (exit ${listed.code})`);
      invalidateWorktrees(db, key);
      return out;
    }

    const seen_at = nowIso();
    const entries = parseWorktreeList(listed.stdout);
    const rows = await mapPool(entries, WORKTREE_CONCURRENCY, (e) =>
      readWorktree(git, e, repo, local, seen_at, fetched.code === 0, out.errors),
    );

    const upsert = db.prepare(UPSERT_SQL);
    const write = db.transaction((batch: WorktreeRow[]) => {
      for (const row of batch) upsert.run(row);
      const paths = batch.map((r) => r.path);
      const holes = paths.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM worktrees WHERE repo = ?${paths.length > 0 ? ` AND path NOT IN (${holes})` : ""}`,
      ).run(key, ...paths);
    });
    write(rows);
    out.seen = rows.length;
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
    try {
      invalidateWorktrees(db, key);
    } catch {
      // A database failure is already reported above; keep the no-throw contract.
    }
  }
  return out;
}

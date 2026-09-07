import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import { CFG, API, insertItem, insertPr, insertWt } from "./__fixtures__/model.js";
import { removeWorktree, WorktreeRemovalError } from "./worktree-removal.js";
import type { GitClient, GitResult } from "./worktrees.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const MAIN = "/synthetic/api";
const PATH = "/synthetic/has spaces; $(literal)/api";
const BRANCH = "feature/resume";
const input = { path: PATH, expected_head: SHA };
const success = (stdout = ""): GitResult => ({ code: 0, stdout });

class FakeGit implements GitClient {
  calls: { cwd: string; args: string[] }[] = [];
  statusCalls = 0;
  headCalls = 0;
  listing = `worktree ${MAIN}\0HEAD ${OTHER}\0branch refs/heads/develop\0\0` +
    `worktree ${PATH}\0HEAD ${SHA}\0branch refs/heads/${BRANCH}\0\0`;
  dirty = false;
  dirtyOnRecheck = false;
  changedHeadOnRecheck = false;
  changedBranch = false;
  branchMissing = false;
  remoteMissing = false;
  unpushed = "0\n";
  ahead = "0\n";
  removeCode = 0;
  failCommand: string | undefined;
  onFinalStatus: (() => void) | undefined;

  async run(cwd: string, args: string[]): Promise<GitResult> {
    this.calls.push({ cwd, args: [...args] });
    if (args[0] === this.failCommand) return { code: 2, stdout: "" };
    if (args[0] === "worktree" && args[1] === "list") return success(this.listing);
    if (args[0] === "worktree" && args[1] === "remove") return { code: this.removeCode, stdout: "" };
    if (args[0] === "status") {
      this.statusCalls++;
      if (this.statusCalls > 1) this.onFinalStatus?.();
      return success(this.dirty || (this.dirtyOnRecheck && this.statusCalls > 1) ? "?? keep-me.txt\n" : "");
    }
    if (args[0] === "symbolic-ref") return success(`refs/heads/${this.changedBranch ? "feature/switched" : BRANCH}\n`);
    if (args[0] === "rev-parse") {
      const ref = args.at(-1)!;
      if (ref === "HEAD^{commit}") {
        this.headCalls++;
        return success(`${this.changedHeadOnRecheck && this.headCalls > 1 ? OTHER : SHA}\n`);
      }
      if (ref === `refs/heads/${BRANCH}^{commit}`) return this.branchMissing ? { code: 1, stdout: "" } : success(`${SHA}\n`);
      if (ref === "refs/remotes/origin/develop^{commit}") return success(`${OTHER}\n`);
      if (ref === `refs/remotes/origin/${BRANCH}^{commit}`) return this.remoteMissing ? { code: 1, stdout: "" } : success(`${SHA}\n`);
    }
    if (args[0] === "rev-list") return success(args.length === 4 ? this.ahead : this.unpushed);
    throw new Error(`Unexpected synthetic call: ${JSON.stringify({ cwd, args })}`);
  }
}

let db: Db;
let git: FakeGit;
beforeEach(() => {
  db = openDb(":memory:");
  insertWt(db, { path: PATH, head_sha: SHA, ahead_of_dev: 0, unpushed: 0, dirty: 0 });
  git = new FakeGit();
});
afterEach(() => { db.close(); });

const hasCached = (): boolean => Boolean(db.prepare(`SELECT path FROM worktrees WHERE path = ?`).get(PATH));
const removalCalls = (): { cwd: string; args: string[] }[] => git.calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove");

async function refused(status = 409): Promise<void> {
  await expect(removeWorktree(db, CFG, input, git)).rejects.toMatchObject({ name: "WorktreeRemovalError", status });
  expect(removalCalls()).toEqual([]);
  expect(hasCached()).toBe(true);
}

describe("guarded dashboard worktree removal", () => {
  it("uses only exact argument-array removal, preserves the branch, and records linked context", async () => {
    insertItem(db);
    insertPr(db, { item_id: 1, state: "MERGED", head_sha: SHA, merge_sha: OTHER });
    await removeWorktree(db, CFG, input, git);
    expect(removalCalls()).toEqual([{ cwd: MAIN, args: ["worktree", "remove", "--", PATH] }]);
    expect(git.calls.at(-1)).toEqual(removalCalls()[0]);
    expect(git.calls.filter((c) => c.args[0] === "status")).toHaveLength(2);
    expect(git.calls.some((c) => ["fetch", "push", "branch", "reset", "clean"].includes(c.args[0]!) || c.args.includes("--force"))).toBe(false);
    expect(hasCached()).toBe(false);
    const event = db.prepare(`SELECT text FROM events WHERE item_id = 1`).get() as { text: string };
    expect(event.text).toContain(`retained branch ${BRANCH} at ${SHA}`);
  });

  it("accepts a missing remote feature branch only when develop already covers all commits", async () => {
    git.remoteMissing = true;
    await removeWorktree(db, CFG, input, git);
    expect(hasCached()).toBe(false);
  });

  it.each(["dirty", "dirtyOnRecheck", "changedHeadOnRecheck", "changedBranch", "branchMissing"] as const)("refuses fresh %s without removing anything", async (flag) => {
    git[flag] = true;
    await refused();
  });

  it("refuses fresh unpushed commits", async () => {
    git.unpushed = "1\n";
    await refused();
  });

  it("refuses work whose remote branch disappeared while it remains ahead of develop", async () => {
    git.remoteMissing = true;
    git.ahead = "2\n";
    await refused();
  });

  it.each(["locked", "prunable", "detached"])("refuses a freshly %s worktree", async (flag) => {
    git.listing = git.listing.slice(0, -1) + `${flag}\0\0`;
    await refused();
  });

  it("refuses missing exact registration", async () => {
    git.listing = `worktree ${MAIN}\0HEAD ${OTHER}\0branch refs/heads/develop\0\0`;
    await refused();
  });

  it("refuses a different registered HEAD", async () => {
    git.listing = git.listing.replace(`HEAD ${SHA}`, `HEAD ${OTHER}`);
    await refused();
  });

  it("refuses the main listing entry even if its cached main flag is wrong", async () => {
    git.listing = `worktree ${PATH}\0HEAD ${SHA}\0branch refs/heads/${BRANCH}\0\0`;
    await refused();
  });

  it.each([
    ["is_main", 1], ["dirty", 1], ["unpushed", 1], ["ahead_of_dev", -1],
  ] as const)("refuses cached %s=%s before touching git", async (column, value) => {
    db.prepare(`UPDATE worktrees SET ${column} = ? WHERE path = ?`).run(value, PATH);
    await refused();
    expect(git.calls).toEqual([]);
  });

  it("refuses unknown or malformed verification results", async () => {
    git.unpushed = "not a number\n";
    await refused();
    git.unpushed = "0\n";
    git.failCommand = "status";
    await refused();
    git.failCommand = undefined;
    git.listing = git.listing.replaceAll("\0", "\n");
    await refused();
  });

  it("retains the cache and reports Git's final refusal", async () => {
    git.removeCode = 1;
    await expect(removeWorktree(db, CFG, input, git)).rejects.toMatchObject({ status: 500 });
    expect(removalCalls()).toHaveLength(1);
    expect(hasCached()).toBe(true);
    expect(db.prepare(`SELECT count(*) AS n FROM events`).get()).toEqual({ n: 0 });
  });

  it("refuses cache changes that land while git verification is in progress", async () => {
    git.onFinalStatus = () => { db.prepare(`UPDATE worktrees SET head_sha = ? WHERE path = ?`).run(OTHER, PATH); };
    await refused();
  });

  it("refuses a newly opened PR that reuses the branch during verification", async () => {
    git.onFinalStatus = () => { insertPr(db, { repo: API, head_sha: SHA, state: "OPEN" }); };
    await refused();
  });

  it("rejects an unknown path or stale confirmation before git is invoked", async () => {
    await expect(removeWorktree(db, CFG, { ...input, path: "/synthetic/unknown" }, git)).rejects.toMatchObject({ status: 404 });
    await expect(removeWorktree(db, CFG, { ...input, expected_head: OTHER }, git)).rejects.toMatchObject({ status: 409 });
    await expect(removeWorktree(db, CFG, { ...input, path: "relative" }, git)).rejects.toBeInstanceOf(WorktreeRemovalError);
    expect(git.calls).toEqual([]);
  });
});

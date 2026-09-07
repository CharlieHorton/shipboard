import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import type { GitClient, GitResult } from "./worktrees.js";
import { parseWorktreeList, siloFor, syncWorktrees } from "./worktrees.js";
import { worktreeStage } from "./stage.js";
import type { RepoConfig, WorktreeRow } from "./types.js";

const HOME = "/Users/example";
const LOCAL = `${HOME}/Projects/example/API`;
const FEATURES = `${HOME}/Projects/example-features`;

const API: RepoConfig = {
  owner: "example",
  name: "API",
  dev_branch: "develop",
  prod_branch: "main",
  deploy: "manual",
  local: LOCAL,
};
const API_KEY = "example/API";

// ---------- parsing ----------

/** Synthetic `git worktree list --porcelain` output, including detached and prunable entries. */
const PORCELAIN = `worktree ${LOCAL}
HEAD 1111111111111111111111111111111111111111
branch refs/heads/develop

worktree ${LOCAL}/.claude/worktrees/email-dark-mode
HEAD 2222222222222222222222222222222222222222
branch refs/heads/worktree-email-dark-mode

worktree ${FEATURES}/sample-feature/API
HEAD 3333333333333333333333333333333333333333
branch refs/heads/feature/sample-feature
locked

worktree ${FEATURES}/spike/API
HEAD 4444444444444444444444444444444444444444
detached

worktree ${FEATURES}/removed-by-hand/API
HEAD 5555555555555555555555555555555555555555
branch refs/heads/feature/removed-by-hand
prunable gitdir file points to non-existent location
`;

describe("parseWorktreeList", () => {
  it("reads every block and strips refs/heads/", () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: LOCAL, head: "1111111111111111111111111111111111111111", branch: "develop" },
      {
        path: `${LOCAL}/.claude/worktrees/email-dark-mode`,
        head: "2222222222222222222222222222222222222222",
        branch: "worktree-email-dark-mode",
      },
      { path: `${FEATURES}/sample-feature/API`, head: "3333333333333333333333333333333333333333", branch: "feature/sample-feature" },
      {
        path: `${FEATURES}/removed-by-hand/API`,
        head: "5555555555555555555555555555555555555555",
        branch: "feature/removed-by-hand",
      },
    ]);
  });

  it("drops detached and bare entries", () => {
    const branches = parseWorktreeList(PORCELAIN).map((w) => w.branch);
    expect(branches).not.toContain("");
    expect(parseWorktreeList("worktree /repo.git\nbare\n")).toEqual([]);
    expect(parseWorktreeList("worktree /a\nHEAD abc\ndetached\n")).toEqual([]);
  });

  it("tolerates an unterminated last block and empty input", () => {
    expect(parseWorktreeList("worktree /a\nHEAD abc\nbranch refs/heads/x")).toEqual([
      { path: "/a", head: "abc", branch: "x" },
    ]);
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });
});

describe("siloFor", () => {
  it("takes the parent directory when the leaf is the repo name", () => {
    expect(siloFor(`${FEATURES}/sample-feature/API`, LOCAL)).toBe("sample-feature");
  });

  it("takes the directory name for a worktree that is not in a silo layout", () => {
    expect(siloFor(`${LOCAL}/.claude/worktrees/email-dark-mode`, LOCAL)).toBe("email-dark-mode");
  });

  it("names the main checkout's own parent (callers blank it out)", () => {
    expect(siloFor(LOCAL, LOCAL)).toBe("example");
  });
});

// ---------- fake git ----------

interface FakeWorktree {
  path: string;
  head: string;
  branch: string;
  /** `rev-list --count origin/<dev>..HEAD` */
  aheadOfDev: number;
  /** `rev-parse --verify -q refs/remotes/origin/<branch>` exits 0 */
  onOrigin: boolean;
  /** `rev-list --count HEAD ^origin/<dev> ^origin/<branch>` (only asked when onOrigin) */
  unpushed: number;
  dirty: boolean;
  lastCommit: string;
  /** The directory is gone: every command in it fails. */
  broken: boolean;
}

function wt(over: Partial<FakeWorktree> & { path: string; branch: string }): FakeWorktree {
  return {
    head: `head-${over.branch}`,
    aheadOfDev: 0,
    onOrigin: false,
    unpushed: 0,
    dirty: false,
    lastCommit: "2026-09-01T10:00:00+01:00",
    broken: false,
    ...over,
  };
}

class FakeGit implements GitClient {
  calls: string[] = [];
  fetchCalls = 0;
  failFetch = false;
  failList = false;
  throwOn: string | undefined;
  countResult: GitResult | undefined;
  remoteResult: GitResult | undefined;
  trees: FakeWorktree[] = [];

  constructor(trees: FakeWorktree[] = []) {
    this.trees = trees;
  }

  private porcelain(): string {
    return this.trees
      .map((t) => `worktree ${t.path}\nHEAD ${t.head}\nbranch refs/heads/${t.branch}\n`)
      .join("\n");
  }

  async run(cwd: string, args: string[]): Promise<GitResult> {
    this.calls.push(`${cwd} :: ${args.join(" ")}`);
    if (this.throwOn !== undefined && args.join(" ").includes(this.throwOn)) {
      throw new Error("git exploded");
    }
    if (args[0] === "fetch") {
      this.fetchCalls += 1;
      return { code: this.failFetch ? 128 : 0, stdout: "" };
    }
    if (args[0] === "worktree") {
      return this.failList ? { code: 128, stdout: "" } : { code: 0, stdout: this.porcelain() };
    }
    const t = this.trees.find((x) => x.path === cwd);
    if (t === undefined || t.broken) return { code: 128, stdout: "" };
    if (args[0] === "status") return { code: 0, stdout: t.dirty ? " M src/app.ts\n" : "" };
    if (args[0] === "log") return { code: 0, stdout: `${t.lastCommit}\n` };
    if (args[0] === "rev-parse") return this.remoteResult ?? { code: t.onOrigin ? 0 : 1, stdout: t.onOrigin ? `${t.head}\n` : "" };
    if (args[0] === "rev-list") {
      if (this.countResult) return this.countResult;
      const n = args.includes("HEAD") && args.length > 3 ? t.unpushed : t.aheadOfDev;
      return { code: 0, stdout: `${n}\n` };
    }
    return { code: 1, stdout: "" };
  }
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

function rows(repo = API_KEY): WorktreeRow[] {
  return db.prepare(`SELECT * FROM worktrees WHERE repo = ? ORDER BY path`).all(repo) as WorktreeRow[];
}

/** The real fleet in miniature: main, a rebased silo branch, forgotten work. */
function fleet(): FakeWorktree[] {
  return [
    wt({ path: LOCAL, branch: "develop", onOrigin: true, lastCommit: "2026-09-03T09:00:00+01:00" }),
    // rebased onto develop: 287 commits ahead of a stale origin/<branch>, 2 its own
    wt({
      path: `${FEATURES}/contractor-profiles/API`,
      branch: "feature/contractor-profiles",
      aheadOfDev: 2,
      onOrigin: true,
      unpushed: 2,
      dirty: true,
    }),
    // never pushed
    wt({ path: `${FEATURES}/sample-feature/API`, branch: "feature/sample-feature", aheadOfDev: 2 }),
    // pushed, no PR yet
    wt({
      path: `${FEATURES}/agency-onboarding/API`,
      branch: "feature/agency-onboarding",
      aheadOfDev: 4,
      onOrigin: true,
      unpushed: 0,
    }),
    // a .claude worktree with nothing on it
    wt({ path: `${LOCAL}/.claude/worktrees/email-dark-mode`, branch: "worktree-email-dark-mode" }),
  ];
}

// ---------- syncWorktrees ----------

describe("syncWorktrees", () => {
  it("does nothing at all without a local checkout", async () => {
    const git = new FakeGit(fleet());
    const { local: _local, ...noLocal } = API;
    const res = await syncWorktrees(db, noLocal, git);
    expect(res).toEqual({ seen: 0, errors: [] });
    expect(git.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("records every worktree with its silo, flags and counts", async () => {
    const git = new FakeGit(fleet());
    const res = await syncWorktrees(db, API, git);

    expect(res).toEqual({ seen: 5, errors: [] });
    expect(git.fetchCalls).toBe(1);

    const bySilo = new Map(rows().map((r) => [r.silo, r]));
    expect(bySilo.get("")).toMatchObject({
      path: LOCAL,
      branch: "develop",
      is_main: 1,
      head_sha: "head-develop",
      last_commit_at: "2026-09-03T09:00:00+01:00",
    });
    // rebased: only its own two commits count as unpushed
    expect(bySilo.get("contractor-profiles")).toMatchObject({
      branch: "feature/contractor-profiles",
      is_main: 0,
      ahead_of_dev: 2,
      unpushed: 2,
      on_origin: 1,
      dirty: 1,
    });
    // no origin/<branch> at all → everything ahead of dev is unpushed
    expect(bySilo.get("sample-feature")).toMatchObject({ ahead_of_dev: 2, unpushed: 2, on_origin: 0, dirty: 0 });
    // pushed, nothing of its own left to push
    expect(bySilo.get("agency-onboarding")).toMatchObject({ ahead_of_dev: 4, unpushed: 0, on_origin: 1 });
    // <checkout>/.claude/worktrees/<name> is its own silo
    expect(bySilo.get("email-dark-mode")).toMatchObject({ branch: "worktree-email-dark-mode", is_main: 0 });
    expect(rows().every((r) => r.repo === API_KEY && r.seen_at !== "")).toBe(true);
  });

  it("asks git exactly the questions the row needs", async () => {
    const only = [wt({ path: `${FEATURES}/sample-feature/API`, branch: "feature/sample-feature", aheadOfDev: 2, onOrigin: true })];
    const git = new FakeGit(only);
    await syncWorktrees(db, API, git);

    expect(git.calls).toEqual([
      `${LOCAL} :: fetch --quiet origin`,
      `${LOCAL} :: worktree list --porcelain`,
      `${FEATURES}/sample-feature/API :: status --porcelain`,
      `${FEATURES}/sample-feature/API :: rev-list --count origin/develop..HEAD`,
      `${FEATURES}/sample-feature/API :: rev-parse --verify -q refs/remotes/origin/feature/sample-feature`,
      `${FEATURES}/sample-feature/API :: rev-list --count HEAD ^origin/develop ^origin/feature/sample-feature`,
      `${FEATURES}/sample-feature/API :: log -1 --format=%cI`,
    ]);
  });

  it("never asks for a remote branch that does not exist", async () => {
    const git = new FakeGit([wt({ path: `${FEATURES}/sample-feature/API`, branch: "feature/sample-feature", aheadOfDev: 2 })]);
    await syncWorktrees(db, API, git);
    expect(git.calls.some((c) => c.includes("^origin/feature/sample-feature"))).toBe(false);
  });

  it("updates rows in place and forgets worktrees that vanished", async () => {
    const git = new FakeGit(fleet());
    await syncWorktrees(db, API, git);
    db.prepare(`INSERT INTO worktrees (path, repo, branch) VALUES ('/other', 'example/web', 'x')`).run();

    git.trees = git.trees.filter((t) => !t.path.endsWith("/sample-feature/API"));
    const first = git.trees[0];
    if (first) first.dirty = true;
    const res = await syncWorktrees(db, API, git);

    expect(res.seen).toBe(4);
    expect(rows().map((r) => r.silo).sort()).toEqual(["", "agency-onboarding", "contractor-profiles", "email-dark-mode"]);
    expect(rows().find((r) => r.is_main === 1)?.dirty).toBe(1);
    expect(rows("example/web")).toHaveLength(1); // another repo is never touched
  });

  it("records a failed fetch and still writes the rows", async () => {
    const git = new FakeGit(fleet());
    git.failFetch = true;
    const res = await syncWorktrees(db, API, git);

    expect(res.seen).toBe(5);
    expect(res.errors).toEqual(["fetch origin failed (exit 128); commit comparisons unavailable"]);
    expect(rows()).toHaveLength(5);
    expect(rows().every((row) => row.ahead_of_dev === -1 && row.unpushed === -1)).toBe(true);
    expect(rows().map((row) => worktreeStage(row, undefined))).not.toContain("empty");
  });

  it("keeps what it knows when the listing itself fails", async () => {
    const git = new FakeGit(fleet());
    await syncWorktrees(db, API, git);
    git.failList = true;
    const res = await syncWorktrees(db, API, git);

    expect(res.seen).toBe(0);
    expect(res.errors).toEqual([`worktree list failed in ${LOCAL} (exit 128)`]);
    expect(rows()).toHaveLength(5);
    expect(rows().every((row) => worktreeStage(row, undefined) === "unknown")).toBe(true);
  });

  it("retains a listed worktree whose directory is unreadable as unknown", async () => {
    const trees = fleet();
    const gone = trees[2]!;
    gone.broken = true;
    const git = new FakeGit(trees);
    const res = await syncWorktrees(db, API, git);

    expect(res.seen).toBe(5);
    expect(res.errors).toEqual([`${gone.path}: local status unavailable (exit 128)`]);
    const unreadable = rows().find((r) => r.path === gone.path)!;
    expect(unreadable).toMatchObject({ ahead_of_dev: -1, unpushed: -1, dirty: -1 });
    expect(worktreeStage(unreadable, undefined)).toBe("unknown");
  });

  it.each([
    { code: 128, stdout: "" },
    { code: 0, stdout: "" },
    { code: 0, stdout: "0 corrupted" },
    { code: 0, stdout: "-1" },
    { code: 0, stdout: "1.5" },
    { code: 0, stdout: "9007199254740992" },
  ])("does not turn failed or malformed commit counts into zero: %j", async (result) => {
    const git = new FakeGit([wt({ path: "/synthetic/feature", branch: "feature", onOrigin: true })]);
    git.countResult = result;
    const res = await syncWorktrees(db, API, git);
    expect(res.errors).toEqual(["/synthetic/feature: commit comparison unavailable"]);
    expect(rows()[0]).toMatchObject({ ahead_of_dev: -1, unpushed: -1 });
    expect(worktreeStage(rows()[0]!, undefined)).toBe("unknown");
  });

  it("distinguishes a failed remote-ref probe from a missing branch", async () => {
    const git = new FakeGit([wt({ path: "/synthetic/feature", branch: "feature" })]);
    git.remoteResult = { code: 128, stdout: "" };
    const res = await syncWorktrees(db, API, git);
    expect(res.errors).toEqual(["/synthetic/feature: commit comparison unavailable"]);
    expect(rows()[0]?.unpushed).toBe(-1);
    expect(worktreeStage(rows()[0]!, undefined)).toBe("unknown");
  });

  it("withdraws a previous clean observation after the worktree becomes unreadable", async () => {
    const tree = wt({ path: "/synthetic/feature", branch: "feature" });
    const git = new FakeGit([tree]);
    await syncWorktrees(db, API, git);
    expect(worktreeStage(rows()[0]!, undefined)).toBe("empty");
    tree.broken = true;
    await syncWorktrees(db, API, git);
    expect(worktreeStage(rows()[0]!, undefined)).toBe("unknown");
  });

  it("never throws", async () => {
    const git = new FakeGit(fleet());
    git.throwOn = "worktree list";
    const res = await syncWorktrees(db, API, git);
    expect(res).toEqual({ seen: 0, errors: ["git exploded"] });
  });
});

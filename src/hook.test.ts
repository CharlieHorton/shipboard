import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CONFIG } from "./__fixtures__/config.js";
import { openDb, type Db } from "./db.js";
import { commandCwd, decide, runHook, type HookDeps, type HookInput } from "./hook.js";
import * as store from "./store.js";
import type { SyncResult } from "./sync.js";
import { beginSync, finishSync, readSyncHealth } from "./sync-health.js";
import type { PrRow, RepoConfig, WorktreeRow } from "./types.js";

// ---------- fixtures ----------

const CFG = TEST_CONFIG;
const API_KEY = "example/API";
const WEB_KEY = "example/web";
const API: RepoConfig = {
  owner: "example",
  name: "API",
  dev_branch: "develop",
  prod_branch: "main",
  deploy: "manual",
};
const CWD = "/Users/x/Projects/API";

const PR_DEFAULTS = {
  item_id: null as number | null,
  title: "a PR",
  author: "example",
  url: "",
  head_branch: "feature/x",
  base_branch: "develop",
  head_sha: "abc123",
  state: "OPEN",
  is_draft: 0,
  review_round: 0,
  unresolved_bot_threads: 0,
  bot_reviews_on_head: 0,
  ci_state: null as string | null,
  merged_at: null as string | null,
  merge_sha: null as string | null,
  in_release_pr: null as number | null,
  on_dev: 0,
  on_prod: 0,
  synced_at: "2026-09-03T00:00:00.000Z",
};

function insertPr(db: Db, over: Partial<PrRow> & { repo: string; number: number }): void {
  const cols = Object.keys(PR_DEFAULTS).concat("repo", "number");
  db.prepare(
    `INSERT INTO prs (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`,
  ).run({ ...PR_DEFAULTS, ...over });
}

/** Worktrees are written by the sync engine; tests insert them by hand. */
function insertWorktree(db: Db, over: Partial<WorktreeRow> & { path: string; branch: string }): void {
  const row: WorktreeRow = {
    repo: API_KEY,
    head_sha: "abc1234",
    silo: "",
    is_main: 0,
    ahead_of_dev: 0,
    unpushed: 0,
    on_origin: 0,
    dirty: 0,
    last_commit_at: "2026-09-01T00:00:00.000Z",
    seen_at: "2026-09-03T00:00:00.000Z",
    ...over,
  };
  db.prepare(
    `INSERT INTO worktrees
       (path, repo, branch, head_sha, silo, is_main, ahead_of_dev, unpushed, on_origin, dirty, last_commit_at, seen_at)
     VALUES
       (@path, @repo, @branch, @head_sha, @silo, @is_main, @ahead_of_dev, @unpushed, @on_origin, @dirty, @last_commit_at, @seen_at)`,
  ).run(row);
}

/** So relative ages in expectations are stable. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 3600_000).toISOString();
}

function syncResult(over: Partial<SyncResult> = {}): SyncResult {
  return { repo: API_KEY, prs_seen: 1, prs_changed: 0, worktrees_seen: 0, changes: [], errors: [], ...over };
}

function event(command: string, cwd = CWD): HookInput {
  return { cwd, tool_name: "Bash", tool_input: { command } };
}

/** Unpack the stdout contract: exactly one hook object with a context string. */
function context(out: string | undefined, event = "PostToolUse"): string {
  expect(typeof out).toBe("string");
  const parsed = JSON.parse(out as string) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
  expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
  return parsed.hookSpecificOutput.additionalContext;
}

function sessionStart(cwd = CWD): HookInput {
  return { cwd, hook_event_name: "SessionStart", source: "startup" };
}

/** So `(synced 12m ago)` is stable no matter when the suite runs. */
const SYNCED_12M = new Date(Date.now() - 12 * 60_000).toISOString();

function healthySources(db: Db): void {
  for (const source of readSyncHealth(db, CFG, { project: "example" })) {
    beginSync(db, source.repo, source.source, SYNCED_12M);
    finishSync(db, source.repo, source.source, [], SYNCED_12M);
  }
}


// ---------- decide ----------

describe("decide", () => {
  const cases: [string, ReturnType<typeof decide>][] = [
    ["git push", { kind: "push" }],
    ["git push -u origin feature/x", { kind: "push" }],
    ["cd /Users/x/Projects/API && git push", { kind: "push" }],
    ["git push && echo done", { kind: "push" }],
    ["git -C /Users/x/Projects/API push", { kind: "push" }],
    ["gh pr create --fill", { kind: "pr-create" }],
    ["gh pr merge", { kind: "pr-merge" }],
    ["gh pr merge 268 --squash", { kind: "pr-merge", number: 268 }],
    ["gh pr ready", { kind: "pr-ready" }],
    ["gh pr ready 12", { kind: "pr-ready", number: 12 }],
    ["gh pr comment 205 --body hi", { kind: "pr-comment", number: 205 }],
    [
      "gh api repos/example/API/pulls/205/comments/999/replies -f body=ok",
      { kind: "pr-reply", number: 205 },
    ],
    ["eas update --branch preview", { kind: "eas" }],
    ["eas build -p ios", { kind: "eas" }],
    ["git status", undefined],
    ["gh pr view 205", undefined],
    ["npm test", undefined],
    ["git log --oneline", undefined],
  ];

  it.each(cases)("%s", (command, expected) => {
    expect(decide(command)).toEqual(expected);
  });

  it("prefers the more specific gh command over the push in the same line", () => {
    expect(decide("gh pr create --fill && git push")).toEqual({ kind: "pr-create" });
  });
});

describe("commandCwd", () => {
  it("reads git -C and a leading cd", () => {
    expect(commandCwd("git -C /a/b push")).toBe("/a/b");
    expect(commandCwd('cd "/a b" && git push')).toBe("/a b");
    expect(commandCwd("git push")).toBeUndefined();
  });
});

// ---------- runHook ----------

describe("runHook", () => {
  let db: Db;
  let sync: ReturnType<typeof vi.fn>;
  let deps: HookDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    sync = vi.fn(async () => [syncResult()]);
    deps = {
      db,
      cfg: CFG,
      sync: sync as unknown as HookDeps["sync"],
      currentBranch: () => "feature/x",
      repoForCwd: () => API,
      timeoutMs: 1_000,
    };
  });

  it("names the item, its stage and the merge-order warning for a linked PR", async () => {
    const item = store.createItem(db, {
      project: "example",
      title: "Stripe Connect for agent companies",
      repo_order: [API_KEY, WEB_KEY],
    });
    insertPr(db, {
      repo: API_KEY,
      number: 205,
      item_id: item.id,
      review_round: 3,
      unresolved_bot_threads: 4,
      bot_reviews_on_head: 1,
      ci_state: "SUCCESS",
    });
    insertPr(db, {
      repo: WEB_KEY,
      number: 284,
      item_id: item.id,
      head_branch: "feature/x-web",
      review_round: 1,
      bot_reviews_on_head: 1,
      ci_state: "SUCCESS",
    });

    const out = await runHook(event("git push -u origin feature/x"), deps);

    expect(sync).toHaveBeenCalledWith([API_KEY]);
    expect(context(out)).toBe(
      `Shipboard: item #${item.id} "Stripe Connect for agent companies" is now needs-addressing ` +
        `(API#205 round 3, 4 unresolved bot threads, CI ✓).\n` +
        "  ! web#284 is ready to merge but API#205 must merge first\n" +
        "  → agent should address the threads",
    );
  });

  it("tells Claude how to create and link an item for an unlinked PR", async () => {
    insertPr(db, { repo: API_KEY, number: 210, head_branch: "feature/x" });

    const out = await runHook(event("gh pr create --fill"), deps);

    expect(context(out)).toBe(
      "Shipboard: no work item tracks API#210 (feature/x). " +
        "Call shipboard_upsert_item with a title, one-paragraph summary and a change list, then " +
        `shipboard_link_pr {item_id, repo: "${API_KEY}", number: 210}. ` +
        "If it belongs to an existing item, shipboard_list first.",
    );
  });

  it("says nothing when a push has no PR yet", async () => {
    expect(await runHook(event("git push"), deps)).toBeUndefined();
    expect(sync).toHaveBeenCalledOnce();
  });

  it("asks for a re-sync when a pr-create still has no PR", async () => {
    const out = await runHook(event("gh pr create --fill"), deps);
    expect(context(out)).toBe(
      "Shipboard: sync ran but found no PR for branch feature/x yet; call shipboard_sync in a moment.",
    );
  });

  it("says nothing for an untracked release PR — the release train is not a work item", async () => {
    insertPr(db, { repo: API_KEY, number: 307, head_branch: "develop", base_branch: "main" });
    deps.currentBranch = () => "develop";
    expect(await runHook(event("git push"), deps)).toBeUndefined();
  });

  it("says nothing, and never syncs, for an unconfigured cwd", async () => {
    deps.repoForCwd = () => undefined;
    expect(await runHook(event("git push", "/Users/x/Projects/unknown"), deps)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it("says nothing for a non-matching command or a non-Bash tool", async () => {
    expect(await runHook(event("npm test"), deps)).toBeUndefined();
    expect(await runHook({ ...event("git push"), tool_name: "Edit" }, deps)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it("selects the PR by number for `gh pr merge 268`", async () => {
    const item = store.createItem(db, { project: "example", title: "Release chores" });
    insertPr(db, {
      repo: API_KEY,
      number: 268,
      item_id: item.id,
      head_branch: "feature/other",
      state: "MERGED",
      merged_at: "2026-09-03T10:00:00.000Z",
      merge_sha: "deadbee",
      on_dev: 1,
    });
    deps.currentBranch = () => {
      throw new Error("must not consult the branch when a number is given");
    };

    const out = await runHook(event("gh pr merge 268 --squash"), deps);

    expect(context(out)).toBe(
      `Shipboard: item #${item.id} "Release chores" is now needs-testing (API#268 merged).\n` +
        "  → waiting for you: test it on dev then `shipboard task done`",
    );
  });

  it("appends the first sync error and up to three other notable changes", async () => {
    const item = store.createItem(db, { project: "example", title: "Stripe Connect" });
    insertPr(db, {
      repo: API_KEY,
      number: 205,
      item_id: item.id,
      review_round: 1,
      bot_reviews_on_head: 1,
      ci_state: "SUCCESS",
    });
    sync.mockResolvedValue([
      syncResult({
        errors: ["compare develop...abc1234: gh api: rate limited", "second error"],
        changes: [
          { repo: API_KEY, number: 205, field: "head_sha", from: "a", to: "b" },
          { repo: API_KEY, number: 268, field: "review_round", from: 2, to: 3 },
          { repo: API_KEY, number: 268, field: "unresolved_bot_threads", from: 0, to: 2 },
          { repo: API_KEY, number: 268, field: "head_sha", from: "c", to: "d" },
          { repo: API_KEY, number: 300, field: "created", from: null, to: "OPEN" },
        ],
      }),
    ]);

    const lines = context(await runHook(event("git push"), deps)).split("\n");

    expect(lines[0]).toBe(
      `Shipboard: item #${item.id} "Stripe Connect" is now ready-to-merge (API#205 round 1, CI ✓).`,
    );
    expect(lines).toContain("  also: API#268 review round 3 landed, 2 unresolved");
    expect(lines).toContain("  (sync: compare develop...abc1234: gh api: rate limited)");
    expect(lines.some((l) => l.includes("#300"))).toBe(false);
    expect(lines.some((l) => l.includes("head_sha"))).toBe(false);
  });

  it("still emits a short line when the sync outruns the timeout", async () => {
    deps.sync = () => new Promise<SyncResult[]>(() => {});
    deps.timeoutMs = 5;
    expect(context(await runHook(event("git push"), deps))).toBe(
      "Shipboard: sync of API timed out; call shipboard_sync in a moment.",
    );
  });
});

// ---------- SessionStart digest ----------

describe("runHook — SessionStart", () => {
  let db: Db;
  let sync: ReturnType<typeof vi.fn>;
  let deps: HookDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    healthySources(db);
    sync = vi.fn(async () => [syncResult()]);
    deps = {
      db,
      cfg: CFG,
      sync: sync as unknown as HookDeps["sync"],
      currentBranch: () => {
        throw new Error("SessionStart must not consult git");
      },
      repoForCwd: () => API,
      timeoutMs: 1_000,
    };
  });

  it("digests the project's attention queue, agent group first, and never syncs", async () => {
    const stripe = store.createItem(db, {
      project: "example",
      title: "Stripe Connect for agent companies",
      repo_order: [API_KEY, WEB_KEY],
    });
    insertPr(db, {
      repo: API_KEY,
      number: 205,
      item_id: stripe.id,
      review_round: 3,
      unresolved_bot_threads: 4,
      bot_reviews_on_head: 1,
      ci_state: "SUCCESS",
      synced_at: SYNCED_12M,
    });
    insertPr(db, {
      repo: WEB_KEY,
      number: 284,
      item_id: stripe.id,
      head_branch: "feature/x-web",
      review_round: 1,
      bot_reviews_on_head: 1,
      ci_state: "SUCCESS",
      synced_at: SYNCED_12M,
    });

    const chinese = store.createItem(db, { project: "example", title: "Chinese translations" });
    insertPr(db, {
      repo: API_KEY,
      number: 237,
      item_id: chinese.id,
      head_branch: "feature/chinese",
      review_round: 1,
      bot_reviews_on_head: 1,
      ci_state: "SUCCESS",
      synced_at: SYNCED_12M,
    });

    // Nothing tracks this one: it lands in the untracked tail.
    insertPr(db, {
      repo: API_KEY,
      number: 300,
      head_branch: "feature/loose",
      review_round: 1,
      unresolved_bot_threads: 3,
      bot_reviews_on_head: 1,
      synced_at: SYNCED_12M,
    });

    const out = await runHook(sessionStart(), deps);

    expect(sync).not.toHaveBeenCalled();
    expect(context(out, "SessionStart")).toBe(
      [
        "Shipboard (example): 3 items need attention — run shipboard_list {attention:true} for detail." +
          " (synced 12m ago)",
        `  #${stripe.id} needs-addressing  Stripe Connect for agent companies  API#205 (4 threads)`,
        "    ! web#284 is ready to merge but API#205 must merge first",
        `  #${chinese.id} ready-to-merge    Chinese translations                API#237`,
        "  untracked: API#300 needs-addressing(3)",
      ].join("\n"),
    );
  });

  it("says nothing when the queue is empty", async () => {
    const item = store.createItem(db, { project: "example", title: "Already shipped" });
    insertPr(db, { repo: API_KEY, number: 1, item_id: item.id, state: "MERGED", merge_sha: "merged-abc", on_dev: 1, on_prod: 1 });
    store.addTask(db, item.id, "test", "tested on dev");
    store.completeTask(db, store.tasksForItem(db, item.id)[0]!.id);
    store.updateItem(db, item.id, { prod_deployed_at: "2026-09-02T00:00:00.000Z" });

    expect(await runHook(sessionStart(), deps)).toBeUndefined();
  });

  it("says nothing for a cwd in no configured repo — that is how it stays opt-in", async () => {
    const item = store.createItem(db, { project: "example", title: "Stripe Connect" });
    insertPr(db, {
      repo: API_KEY,
      number: 205,
      item_id: item.id,
      review_round: 1,
      unresolved_bot_threads: 2,
      bot_reviews_on_head: 1,
    });
    deps.repoForCwd = () => undefined;

    expect(await runHook(sessionStart("/Users/x/Projects/unknown"), deps)).toBeUndefined();
  });

  it("caps the digest at ten lines and counts the remainder", async () => {
    for (let i = 0; i < 12; i++) {
      const item = store.createItem(db, { project: "example", title: `Work item ${i}` });
      insertPr(db, {
        repo: API_KEY,
        number: 400 + i,
        item_id: item.id,
        head_branch: `feature/${i}`,
        review_round: 1,
        unresolved_bot_threads: 1,
        bot_reviews_on_head: 1,
        synced_at: SYNCED_12M,
      });
    }

    const lines = context(await runHook(sessionStart(), deps), "SessionStart").split("\n");

    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("12 items need attention");
    expect(lines[8]).toContain("Work item 7");
    expect(lines[9]).toBe("  …and 4 more");
  });

  it("reports missing source observations before the first sync", async () => {
    db.prepare("DELETE FROM sync_health").run();
    const item = store.createItem(db, { project: "example", title: "Fresh install" });
    insertPr(db, {
      repo: API_KEY,
      number: 205,
      item_id: item.id,
      review_round: 1,
      unresolved_bot_threads: 1,
      bot_reviews_on_head: 1,
      synced_at: "",
    });

    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("1 item needs attention");
    expect(text).toContain("API/github never synced");
    expect(text).not.toContain("(synced");
  });

  it("shows CI failure even when another PR keeps the item in drafting", async () => {
    const item = store.createItem(db, { project: "example", title: "Draft with failing companion" });
    insertPr(db, { repo: API_KEY, number: 301, item_id: item.id, is_draft: 1 });
    insertPr(db, { repo: WEB_KEY, number: 302, item_id: item.id, ci_state: "FAILURE" });
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("drafting + ci-failing");
    expect(text).toContain("web#302");
    expect(sync).not.toHaveBeenCalled();
  });

  it("shows failing CI on an unlinked draft PR", async () => {
    insertPr(db, { repo: API_KEY, number: 303, is_draft: 1, ci_state: "ERROR" });
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("untracked: API#303 ci-failing");
  });

  it("reports failed sources even when cached data has no actions", async () => {
    beginSync(db, API_KEY, "github");
    finishSync(db, API_KEY, "github", ["Synthetic auth failure"]);
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("no actions in cached data");
    expect(text).toContain("API/github failed");
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not let a newer source hide a stale repository", async () => {
    beginSync(db, WEB_KEY, "github", daysAgo(1));
    finishSync(db, WEB_KEY, "github", [], daysAgo(1));
    beginSync(db, API_KEY, "github");
    finishSync(db, API_KEY, "github", []);
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("web/github stale");
    expect(text).not.toContain("(synced");
  });

  it("does not imply healthy sources on an empty first run", async () => {
    db.prepare("DELETE FROM sync_health").run();
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("no actions in cached data");
    expect(text).toContain("never synced");
    expect(sync).not.toHaveBeenCalled();
  });

  it("leaves the PostToolUse path alone", async () => {
    insertPr(db, { repo: API_KEY, number: 210, head_branch: "feature/x" });
    deps.currentBranch = () => "feature/x";

    const out = await runHook({ ...event("gh pr create --fill"), hook_event_name: "PostToolUse" }, deps);

    expect(sync).toHaveBeenCalledWith([API_KEY]);
    expect(context(out)).toContain("no work item tracks API#210");
  });
});

// ---------- worktrees ----------

describe("runHook — worktrees", () => {
  let db: Db;
  let deps: HookDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    deps = {
      db,
      cfg: CFG,
      sync: (async () => [syncResult()]) as unknown as HookDeps["sync"],
      currentBranch: () => "feature/x",
      repoForCwd: () => API,
      timeoutMs: 1_000,
    };
  });

  it("asks for a PR once a branch is pushed with commits ahead of dev", async () => {
    insertWorktree(db, {
      path: "/w/sample-feature/API",
      branch: "feature/x",
      silo: "sample-feature",
      ahead_of_dev: 2,
      unpushed: 0,
      on_origin: 1,
    });

    expect(context(await runHook(event("git push"), deps))).toBe(
      "Shipboard: feature/x is pushed but has no PR (2 commits ahead of develop). " +
        "Open one with gh pr create, then shipboard_link_pr.",
    );
  });

  it("stays quiet while the commits are still only local, or when nothing is ahead", async () => {
    insertWorktree(db, {
      path: "/w/sample-feature/API",
      branch: "feature/x",
      silo: "sample-feature",
      ahead_of_dev: 2,
      unpushed: 2,
    });
    expect(await runHook(event("git push"), deps)).toBeUndefined();

    db.prepare("UPDATE worktrees SET ahead_of_dev = 0, unpushed = 0, on_origin = 1").run();
    expect(await runHook(event("git push"), deps)).toBeUndefined();
  });

  it("says nothing about the worktree once the branch has a PR", async () => {
    insertWorktree(db, {
      path: "/w/sample-feature/API",
      branch: "feature/x",
      silo: "sample-feature",
      ahead_of_dev: 2,
      on_origin: 1,
    });
    insertPr(db, { repo: API_KEY, number: 210, head_branch: "feature/x" });

    expect(context(await runHook(event("git push"), deps))).toContain("no work item tracks API#210");
  });

  it("lists forgotten local work in the SessionStart digest, oldest silo first", async () => {
    insertWorktree(db, {
      path: "/w/sample-feature/API",
      branch: "feature/sample-feature",
      silo: "sample-feature",
      ahead_of_dev: 2,
      unpushed: 2,
      last_commit_at: daysAgo(1),
    });
    insertWorktree(db, {
      path: "/w/agent-analytics/API",
      branch: "feature/analytics",
      silo: "agent-analytics",
      ahead_of_dev: 1,
      unpushed: 1,
      last_commit_at: daysAgo(3),
    });

    const lines = context(await runHook(sessionStart(), deps), "SessionStart").split("\n");

    expect(lines[0]).toContain("2 items need attention");
    expect(lines[1]).toBe(
      "  forgotten: agent-analytics (API 1 unpushed, 3d ago) · sample-feature (API 2 unpushed, 1d ago)",
    );
  });

  it("counts an item's own silo as the item's, not as forgotten work", async () => {
    insertWorktree(db, {
      path: "/w/sample-feature/API",
      branch: "feature/sample-feature",
      silo: "sample-feature",
      ahead_of_dev: 2,
      unpushed: 2,
      last_commit_at: daysAgo(1),
    });
    const item = store.createItem(db, { project: "example", title: "Lofti", silo: "sample-feature" });

    const lines = context(await runHook(sessionStart(), deps), "SessionStart").split("\n");

    // The item owns the silo, so it is an item line, not forgotten work.
    expect(lines.some((l) => l.startsWith("  forgotten:"))).toBe(false);
    expect(lines[1]).toBe(`  #${item.id} local-only  Lofti  API⎇feature/sample-feature local-only(2 unpushed)`);
  });
  it("includes unknown and pushed work with no PR in the digest", async () => {
    insertWorktree(db, { path: "/synthetic/unknown", branch: "feature/unknown", silo: "unknown", ahead_of_dev: -1, unpushed: -1, dirty: -1 });
    insertWorktree(db, { path: "/synthetic/pushed", branch: "feature/pushed", silo: "pushed", ahead_of_dev: 3, on_origin: 1 });
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain("2 items need attention");
    expect(text).toContain("local state unknown");
    expect(text).toContain("3 ahead, needs PR");
    expect(text).not.toContain("-1");
  });

  it("formats dirty-only work without inventing an unpushed commit count", async () => {
    insertWorktree(db, { path: "/synthetic/dirty", branch: "feature/dirty", silo: "dirty", dirty: 1, ahead_of_dev: -1, unpushed: -1 });
    const item = store.createItem(db, { project: "example", title: "Dirty-only item", silo: "dirty" });
    const text = context(await runHook(sessionStart(), deps), "SessionStart");
    expect(text).toContain(`#${item.id} local-only`);
    expect(text).toContain("uncommitted changes, commit counts unknown");
    expect(text).not.toContain("-1 unpushed");
    expect(text).not.toContain("0 unpushed");
  });

});

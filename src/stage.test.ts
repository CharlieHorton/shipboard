import { describe, expect, it } from "vitest";
import { captureEvidence } from "./evidence.js";
import { findRepo } from "./config.js";
import { TEST_CONFIG } from "./__fixtures__/config.js";
import { actorFor, itemStage, mergeOrderWarnings, prStage, prStageRank, stageRank, worktreeStage } from "./stage.js";
import type { ItemRow, PrRow, PrStage, TaskRow, WorktreeRow } from "./types.js";

const API = "example/API"; // develop -> main
const WEB = "example/web"; // develop -> main
const TENANTS = "example/tenants"; // main -> main

const cfg = TEST_CONFIG;
const repoOf = (key: string) => findRepo(cfg, key);

/** Defaults produce an open, reviewed, green PR: `ready-to-merge`. */
function mkPr(p: Partial<PrRow> = {}): PrRow {
  return {
    id: 1,
    item_id: null,
    repo: API,
    number: 205,
    title: "Add Stripe Connect",
    author: "example",
    url: "",
    head_branch: "feature/stripe-connect",
    base_branch: "develop",
    head_sha: "aaaaaaa",
    state: "OPEN",
    is_draft: 0,
    review_round: 1,
    unresolved_bot_threads: 0,
    bot_reviews_on_head: 1,
    ci_state: "SUCCESS",
    merged_at: null,
    merge_sha: null,
    in_release_pr: null,
    on_dev: 0,
    on_prod: 0,
    deployed_at: null,
    deploy_ref: null,
    synced_at: "2026-09-03T00:00:00.000Z",
    ...p,
  };
}

function mkItem(p: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 12,
    project: "example",
    title: "Stripe Connect agents",
    summary: null,
    changes: null,
    linear_key: null,
    silo: null,
    repo_order: null,
    stage_override: null,
    blocked_reason: null,
    prod_deployed_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    archived_at: null,
    ...p,
  };
}

/** Defaults produce a pushed silo worktree with no PR: `needs-pr`. */
function mkWorktree(p: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/Users/example/Projects/example-features/stripe-connect/API",
    repo: API,
    branch: "feature/stripe-connect",
    head_sha: "bbbbbbb",
    silo: "stripe-connect",
    is_main: 0,
    ahead_of_dev: 2,
    unpushed: 0,
    on_origin: 1,
    dirty: 0,
    last_commit_at: "2026-09-02T09:00:00+01:00",
    seen_at: "2026-09-03T00:00:00.000Z",
    ...p,
  };
}

function mkTask(p: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1,
    item_id: 12,
    kind: "other",
    text: "task",
    created_at: "2026-09-01T00:00:00.000Z",
    done_at: null,
    ...p,
  };
}

function testDone(prs: PrRow[]): TaskRow {
  return mkTask({ id: 1, kind: "test", text: "smoke on dev", done_at: "2026-09-02T00:00:00.000Z", completion_evidence: captureEvidence(prs) });
}

/** A merged PR that has landed on dev but not prod. */
const mergedToDev = { state: "MERGED", merged_at: "x", merge_sha: "m", on_dev: 1 } as const;

describe("prStage", () => {
  it("closed wins over everything", () => {
    expect(prStage(mkPr({ state: "CLOSED", is_draft: 1 }), repoOf(API))).toBe("closed");
  });

  it("merged and on prod is merged-main", () => {
    expect(prStage(mkPr({ ...mergedToDev, on_prod: 1 }), repoOf(API))).toBe("merged-main");
  });

  it("merged straight into the prod branch is merged-main", () => {
    const pr = mkPr({ repo: TENANTS, ...mergedToDev, base_branch: "main" });
    expect(prStage(pr, repoOf(TENANTS))).toBe("merged-main");
  });

  it("merged into a release PR is in-release", () => {
    expect(prStage(mkPr({ ...mergedToDev, in_release_pr: 307 }), repoOf(API))).toBe("in-release");
  });

  it("merged into develop is merged-develop", () => {
    expect(prStage(mkPr(mergedToDev), repoOf(API))).toBe("merged-develop");
  });

  it("an unconfigured repo cannot claim the prod-branch shortcut", () => {
    expect(prStage(mkPr({ ...mergedToDev, base_branch: "main" }), undefined)).toBe("merged-develop");
  });

  it("draft is drafting", () => {
    expect(prStage(mkPr({ is_draft: 1 }), repoOf(API))).toBe("drafting");
  });

  it("no review round yet is awaiting-review", () => {
    expect(prStage(mkPr({ review_round: 0, bot_reviews_on_head: 0 }), repoOf(API))).toBe("awaiting-review");
  });

  it("pushed since the last round is awaiting-re-review", () => {
    expect(prStage(mkPr({ review_round: 1, bot_reviews_on_head: 0 }), repoOf(API))).toBe("awaiting-re-review");
  });

  it("unresolved bot threads is needs-addressing", () => {
    expect(prStage(mkPr({ unresolved_bot_threads: 4 }), repoOf(API))).toBe("needs-addressing");
  });

  it("unresolved threads outrank failing CI", () => {
    const pr = mkPr({ unresolved_bot_threads: 1, ci_state: "FAILURE" });
    expect(prStage(pr, repoOf(API))).toBe("needs-addressing");
  });

  it.each(["FAILURE", "ERROR"] as const)("ci %s is ci-failing", (ci) => {
    expect(prStage(mkPr({ ci_state: ci }), repoOf(API))).toBe("ci-failing");
  });

  it.each(["PENDING", "EXPECTED"] as const)("ci %s is awaiting-ci", (ci) => {
    expect(prStage(mkPr({ ci_state: ci }), repoOf(API))).toBe("awaiting-ci");
  });

  it("green CI is ready-to-merge", () => {
    expect(prStage(mkPr({ ci_state: "SUCCESS" }), repoOf(API))).toBe("ready-to-merge");
  });

  it("no checks at all counts as green", () => {
    expect(prStage(mkPr({ ci_state: null }), repoOf(API))).toBe("ready-to-merge");
  });
});

describe("worktreeStage", () => {
  it("hands the stage to an open PR after checking local work", () => {
    expect(worktreeStage(mkWorktree(), mkPr())).toBe("has-pr");
    expect(worktreeStage(mkWorktree(), mkPr({ is_draft: 1 }))).toBe("has-pr");
  });

  it("does not treat a closed PR as an active proposal", () => {
    expect(worktreeStage(mkWorktree(), mkPr({ state: "CLOSED" }))).toBe("needs-pr");
  });

  it("requires the merged PR to cover the current worktree head", () => {
    expect(worktreeStage(mkWorktree({ head_sha: "aaaaaaa" }), mkPr({ state: "MERGED" }))).toBe("merged");
    expect(worktreeStage(mkWorktree(), mkPr({ state: "MERGED" }))).toBe("needs-pr");
  });

  it("with no PR: nothing ahead of dev is empty", () => {
    expect(worktreeStage(mkWorktree({ ahead_of_dev: 0, unpushed: 0 }), undefined)).toBe("empty");
  });

  it("with no PR: commits that are on no remote are local-only", () => {
    expect(worktreeStage(mkWorktree({ ahead_of_dev: 2, unpushed: 2, on_origin: 0 }), undefined)).toBe("local-only");
    expect(worktreeStage(mkWorktree({ ahead_of_dev: 2, unpushed: 2, on_origin: 1 }), undefined)).toBe("local-only");
  });

  it.each([undefined, "OPEN", "MERGED", "CLOSED"] as const)("preserves dirty-only work with PR state %s", (state) => {
    const pr = state ? mkPr({ state }) : undefined;
    expect(worktreeStage(mkWorktree({ ahead_of_dev: 0, unpushed: 0, dirty: 1 }), pr)).toBe("local-only");
  });

  it.each(["OPEN", "MERGED", "CLOSED"] as const)("preserves unpushed work with PR state %s", (state) => {
    expect(worktreeStage(mkWorktree({ unpushed: 1 }), mkPr({ state }))).toBe("local-only");
  });

  it.each([
    { ahead_of_dev: -1 },
    { unpushed: -1 },
    { dirty: -1 as const },
    { head_sha: "" },
  ])("does not suggest cleanup with incomplete observations: %j", (observation) => {
    const tree = mkWorktree({ head_sha: "aaaaaaa", ahead_of_dev: 0, unpushed: 0, ...observation });
    expect(worktreeStage(tree, undefined)).toBe("unknown");
    expect(worktreeStage(tree, mkPr({ state: "MERGED" }))).toBe("unknown");
  });

  it("still surfaces known dirty work when commit comparison fails", () => {
    expect(worktreeStage(mkWorktree({ dirty: 1, ahead_of_dev: -1, unpushed: -1 }), undefined)).toBe("local-only");
  });

  it("with no PR: pushed commits are needs-pr", () => {
    expect(worktreeStage(mkWorktree({ ahead_of_dev: 4, unpushed: 0, on_origin: 1 }), undefined)).toBe("needs-pr");
  });

  it("does not discard local work because it is in the main checkout", () => {
    const main = mkWorktree({ is_main: 1, branch: "develop", silo: "", ahead_of_dev: 9, unpushed: 9 });
    expect(worktreeStage(main, undefined)).toBe("local-only");
    expect(worktreeStage(main, mkPr())).toBe("local-only");
  });
});

describe("stageRank", () => {
  it("ranks local work below every PR stage", () => {
    expect(stageRank("local-only")).toBeLessThan(stageRank("needs-pr"));
    expect(stageRank("needs-pr")).toBeLessThan(stageRank("drafting"));
    expect(stageRank("ready-to-merge")).toBeLessThan(stageRank("merged-develop"));
  });
});

describe("prStageRank", () => {
  it("orders actionable stages below waiting stages", () => {
    const order: PrStage[] = [
      "drafting",
      "needs-addressing",
      "ci-failing",
      "awaiting-review",
      "awaiting-re-review",
      "awaiting-ci",
      "ready-to-merge",
      "merged-develop",
      "in-release",
      "merged-main",
      "closed",
    ];
    const ranks = order.map(prStageRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("itemStage", () => {
  it("1. blocked_reason wins over an override", () => {
    const item = mkItem({ blocked_reason: "waiting on Stripe", stage_override: "done" });
    expect(itemStage(item, [mkPr()], [], cfg)).toBe("blocked");
  });

  it("1. an empty blocked_reason does not block", () => {
    const item = mkItem({ blocked_reason: "   " });
    expect(itemStage(item, [mkPr()], [], cfg)).toBe("ready-to-merge");
  });

  it("2. stage_override is returned verbatim", () => {
    const item = mkItem({ stage_override: "tested" });
    expect(itemStage(item, [mkPr()], [], cfg)).toBe("tested");
  });

  it("3. no active PRs is drafting", () => {
    expect(itemStage(mkItem(), [], [], cfg)).toBe("drafting");
    expect(itemStage(mkItem(), [mkPr({ state: "CLOSED" })], [], cfg)).toBe("drafting");
  });

  it("4. least advanced PR while anything is pre-merge", () => {
    const prs = [
      mkPr({ id: 1, repo: API, number: 205, unresolved_bot_threads: 4 }),
      mkPr({ id: 2, repo: WEB, number: 284 }),
    ];
    expect(itemStage(mkItem(), prs, [], cfg)).toBe("needs-addressing");
  });

  it("4. a merged PR does not hide an open one", () => {
    const prs = [mkPr({ id: 1, ...mergedToDev }), mkPr({ id: 2, repo: WEB, number: 284, is_draft: 1 })];
    expect(itemStage(mkItem(), prs, [], cfg)).toBe("drafting");
  });

  it("5. merged but not yet on dev", () => {
    const prs = [mkPr({ ...mergedToDev, on_dev: 0, in_release_pr: 307 })];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("merged-develop");
  });

  it("6. on dev with no completed test task", () => {
    const prs = [mkPr(mergedToDev)];
    expect(itemStage(mkItem(), prs, [mkTask({ kind: "test" })], cfg)).toBe("needs-testing");
  });

  it("7. all merged-main and prod deploy not asserted", () => {
    const prs = [mkPr({ ...mergedToDev, on_prod: 1 })];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("needs-prod-deploy");
  });

  it.each(["SUCCESS", "FAILURE"] as const)("keeps API and web on main without test tasks when web CI is %s", (ci_state) => {
    const prs = [
      mkPr({ ...mergedToDev, repo: API, number: 305, on_prod: 1 }),
      mkPr({ ...mergedToDev, id: 2, repo: WEB, number: 357, on_prod: 1, ci_state }),
    ];
    expect(itemStage(mkItem(), prs, [], cfg)).toBe("needs-prod-deploy");
  });

  it("7. an OTA deploy on every PR counts as the prod assertion", () => {
    const prs = [
      mkPr({ id: 1, repo: TENANTS, base_branch: "main", ...mergedToDev, on_prod: 1, deployed_at: "2026-08-20T16:38:54.643Z", deploy_ref: "c34dac85" }),
    ];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("done");
    expect(itemStage(mkItem(), prs, [], cfg)).toBe("needs-post-deploy");
  });

  it("7. one PR shipped by OTA and one not is still needs-prod-deploy", () => {
    const prs = [
      mkPr({ id: 1, repo: TENANTS, base_branch: "main", ...mergedToDev, on_prod: 1, deployed_at: "2026-08-20T16:38:54.643Z" }),
      mkPr({ id: 2, repo: API, number: 6, ...mergedToDev, on_prod: 1 }),
    ];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("needs-prod-deploy");
  });

  it("7. an asserted prod deploy still counts on its own", () => {
    const prs = [mkPr({ ...mergedToDev, on_prod: 1 })];
    const item = mkItem({ prod_deployed_at: "2026-09-03T00:00:00.000Z", prod_deploy_evidence: captureEvidence(prs) });
    expect(itemStage(item, prs, [testDone(prs)], cfg)).toBe("done");
  });

  it("7. deployed to prod with an open chore", () => {
    const prs = [mkPr({ ...mergedToDev, on_prod: 1 })];
    const item = mkItem({ prod_deployed_at: "2026-09-03T00:00:00.000Z", prod_deploy_evidence: captureEvidence(prs) });
    const tasks = [testDone(prs), mkTask({ id: 2, kind: "flag", text: "flip the flag" })];
    expect(itemStage(item, prs, tasks, cfg)).toBe("needs-post-deploy");
  });

  it("7. deployed to prod with everything closed out", () => {
    const prs = [mkPr({ ...mergedToDev, on_prod: 1 })];
    const item = mkItem({ prod_deployed_at: "2026-09-03T00:00:00.000Z", prod_deploy_evidence: captureEvidence(prs) });
    const tasks = [testDone(prs), mkTask({ id: 2, kind: "flag", done_at: "2026-09-03T01:00:00.000Z" })];
    expect(itemStage(item, prs, tasks, cfg)).toBe("done");
  });

  it("8. tested and sitting in develop needs a release PR", () => {
    const prs = [mkPr(mergedToDev)];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("needs-release");
  });

  it("8. a repo whose dev branch is its prod branch never needs a release", () => {
    const prs = [mkPr({ repo: TENANTS, base_branch: "main", ...mergedToDev, on_prod: 1 })];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("needs-prod-deploy");
  });

  it("9. riding an open release PR", () => {
    const prs = [
      mkPr({ id: 1, ...mergedToDev, in_release_pr: 307 }),
      mkPr({ id: 2, repo: WEB, number: 284, ...mergedToDev, on_prod: 1 }),
    ];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg)).toBe("in-release");
  });
});

describe("itemStage with local worktrees", () => {
  const localOnly = mkWorktree({ branch: "feature/sample-feature", silo: "sample-feature", ahead_of_dev: 2, unpushed: 2, on_origin: 0 });
  const needsPr = mkWorktree({ branch: "feature/agency-onboarding", silo: "agency-onboarding", ahead_of_dev: 4 });
  const emptyWt = mkWorktree({ branch: "feature/stale", silo: "stale", ahead_of_dev: 0, unpushed: 0 });

  it("3a. commits that exist only on this machine outrank every PR", () => {
    const prs = [mkPr({ id: 1, repo: WEB, number: 284, unresolved_bot_threads: 4 })];
    expect(itemStage(mkItem(), prs, [], cfg, [localOnly])).toBe("local-only");
    expect(itemStage(mkItem(), [], [], cfg, [localOnly])).toBe("local-only");
  });

  it("3a. a merged item with unpushed work beside it is still local-only", () => {
    const prs = [mkPr({ ...mergedToDev, on_prod: 1 })];
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg, [localOnly])).toBe("local-only");
  });

  it("1-2. blocked and overrides still win", () => {
    const blocked = mkItem({ blocked_reason: "waiting on Stripe" });
    expect(itemStage(blocked, [], [], cfg, [localOnly])).toBe("blocked");
    expect(itemStage(mkItem({ stage_override: "tested" }), [], [], cfg, [localOnly])).toBe("tested");
  });

  it("3. the main checkout is never the item's work", () => {
    const main = mkWorktree({ is_main: 1, branch: "develop", silo: "", ahead_of_dev: 30, unpushed: 30 });
    expect(itemStage(mkItem(), [], [], cfg, [main])).toBe("drafting");
  });

  it("3b. a pushed branch with no PR is needs-pr", () => {
    expect(itemStage(mkItem(), [], [], cfg, [needsPr])).toBe("needs-pr");
  });

  it("3b. leftovers with nothing on them are just drafting", () => {
    const merged = mkWorktree({ branch: "feature/shipped", silo: "shipped", head_sha: "aaaaaaa" });
    const prs = [mkPr({ head_branch: "feature/shipped", ...mergedToDev, state: "MERGED" })];
    expect(itemStage(mkItem(), [], [], cfg, [emptyWt])).toBe("drafting");
    expect(itemStage(mkItem(), prs, [testDone(prs)], cfg, [merged, emptyWt])).toBe("needs-release");
  });

  it("3b. a worktree whose branch already has an open PR adds nothing", () => {
    const prs = [mkPr({ is_draft: 1 })];
    expect(itemStage(mkItem(), prs, [], cfg, [mkWorktree()])).toBe("drafting");
  });

  it("4a. needs-pr surfaces once every PR is ready or merged", () => {
    const ready = [mkPr({ ci_state: "SUCCESS" })];
    expect(itemStage(mkItem(), ready, [], cfg, [needsPr])).toBe("needs-pr");

    const merged = [mkPr(mergedToDev)];
    expect(itemStage(mkItem(), merged, [], cfg, [needsPr])).toBe("needs-pr");
    expect(itemStage(mkItem(), merged, [testDone(merged)], cfg, [needsPr])).toBe("needs-pr");
  });

  it("4a. needs-pr never hides a PR somebody has to act on", () => {
    for (const pr of [
      mkPr({ unresolved_bot_threads: 4 }),
      mkPr({ ci_state: "FAILURE" }),
      mkPr({ review_round: 0, bot_reviews_on_head: 0 }),
      mkPr({ is_draft: 1 }),
    ]) {
      expect(itemStage(mkItem(), [pr], [], cfg, [needsPr])).toBe(prStage(pr, repoOf(API)));
    }
  });

  it("4a. the least advanced PR still decides among several", () => {
    const prs = [
      mkPr({ id: 1, repo: API, number: 205 }),
      mkPr({ id: 2, repo: WEB, number: 284, ci_state: "FAILURE" }),
    ];
    expect(itemStage(mkItem(), prs, [], cfg, [needsPr])).toBe("ci-failing");
  });
});

describe("actorFor", () => {
  it("routes work to an agent, a human, or nobody", () => {
    for (const s of ["local-only", "needs-pr", "needs-addressing", "ci-failing"] as const) {
      expect(actorFor(s)).toBe("agent");
    }
    for (const s of ["ready-to-merge", "needs-testing", "needs-release", "needs-prod-deploy", "needs-post-deploy", "blocked"] as const) {
      expect(actorFor(s)).toBe("human");
    }
    for (const s of ["drafting", "awaiting-review", "awaiting-re-review", "awaiting-ci", "merged-develop", "in-release", "merged-main", "tested", "done"] as const) {
      expect(actorFor(s)).toBeNull();
    }
  });
});

describe("mergeOrderWarnings", () => {
  const item = mkItem({ repo_order: JSON.stringify([API, WEB]) });

  it("warns when the later repo is ready before the earlier one merged", () => {
    const prs = [
      mkPr({ id: 1, repo: API, number: 205, unresolved_bot_threads: 4 }),
      mkPr({ id: 2, repo: WEB, number: 284 }),
    ];
    expect(mergeOrderWarnings(item, prs, cfg)).toEqual([
      "web#284 is ready to merge but API#205 must merge first",
    ]);
  });

  it("is quiet once the earlier repo has merged", () => {
    const prs = [
      mkPr({ id: 1, repo: API, number: 205, ...mergedToDev }),
      mkPr({ id: 2, repo: WEB, number: 284 }),
    ];
    expect(mergeOrderWarnings(item, prs, cfg)).toEqual([]);
  });

  it("is quiet when the ready PR is the earlier repo", () => {
    const prs = [
      mkPr({ id: 1, repo: API, number: 205 }),
      mkPr({ id: 2, repo: WEB, number: 284, unresolved_bot_threads: 2 }),
    ];
    expect(mergeOrderWarnings(item, prs, cfg)).toEqual([]);
  });

  it("needs an order to warn about", () => {
    const prs = [mkPr({ id: 1, repo: API }), mkPr({ id: 2, repo: WEB, number: 284 })];
    expect(mergeOrderWarnings(mkItem(), prs, cfg)).toEqual([]);
  });
});

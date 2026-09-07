import { describe, expect, it } from "vitest";
import { itemActions, nextActions, prActions } from "./actions.js";
import { API, WEB, CFG, AT, item, pr, wt } from "./__fixtures__/model.js";
import { actorFor, itemStage, worktreeStage } from "./stage.js";
import { viewPr, type ItemView, type LsSections } from "./views.js";
import type { ItemRow, PrRow, WorktreeRow } from "./types.js";

function view(it: ItemRow, prs: PrRow[], worktrees: WorktreeRow[] = []): ItemView {
  const stage = itemStage(it, prs, [], CFG, worktrees);
  return { item: it, stage, actor: actorFor(stage), prs: prs.map((p) => viewPr(p, CFG)), warnings: [],
    worktrees: worktrees.map((w) => {
      const linked = prs.find((p) => p.repo === w.repo && p.head_branch === w.branch);
      return { wt: w, pr: linked, stage: worktreeStage(w, linked) };
    }) };
}

describe("independent next actions", () => {
  it.each([
    { is_draft: 1 as const },
    { review_round: 0, bot_reviews_on_head: 0 as const },
    { review_round: 2, bot_reviews_on_head: 0 as const },
  ])("exposes failing CI while lifecycle waits elsewhere: %j", (reviewState) => {
    const p = pr({ ...reviewState, ci_state: "FAILURE" });
    const actions = prActions(viewPr(p, CFG));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "ci-failing", actor: "agent", url: p.url });
    expect(actions[0]?.reason).toContain(p.head_sha);
  });

  it("retains CI and review work on a multi-repo item fronted by a draft", () => {
    const v = view(item(), [pr({ is_draft: 1 }), pr({ id: 2, repo: WEB, ci_state: "ERROR", unresolved_bot_threads: 3 })]);
    expect(v.stage).toBe("drafting");
    expect(itemActions(v).map((a) => a.kind)).toEqual(["ci-failing", "needs-addressing"]);
    expect(itemActions(v).every((a) => a.item_id === 1 && a.project === "alpha")).toBe(true);
  });

  it.each(["absent", "draft", "closed"])("requires earlier merge-order repositories even if %s", (state) => {
    const earlier = state === "absent" ? [] : [pr({ is_draft: 1, state: state === "closed" ? "CLOSED" : "OPEN" })];
    const v = view(item({ repo_order: JSON.stringify([API, WEB]) }), [...earlier, pr({ id: 2, repo: WEB })]);
    const actions = itemActions(v);
    expect(actions.some((a) => a.kind === "ready-to-merge")).toBe(false);
    expect(actions.find((a) => a.kind === "merge-prerequisite")?.reason).toContain(API);
  });

  it("offers a downstream merge review once its prerequisite has merged", () => {
    const v = view(item({ repo_order: JSON.stringify([API, WEB]) }), [
      pr({ state: "MERGED", merge_sha: "merge-a", on_dev: 1 }), pr({ id: 2, repo: WEB }),
    ]);
    expect(itemActions(v).map((a) => a.kind)).toEqual(["ready-to-merge"]);
  });

  it("treats a whitespace-only blocker consistently with the unblocked lifecycle stage", () => {
    const v = view(item({ blocked_reason: "   " }), [pr()]);
    expect(v.stage).toBe("ready-to-merge");
    expect(itemActions(v).map((a) => a.kind)).toEqual(["ready-to-merge"]);
  });

  it("preserves dirty work alongside a ready PR and replaces merge with prerequisite inspection", () => {
    const v = view(item(), [pr()], [wt({ dirty: 1, unpushed: 0, ahead_of_dev: 0 })]);
    const actions = itemActions(v);
    expect(actions.map((a) => a.kind)).toEqual(["local-only", "merge-prerequisite"]);
    expect(actions[0]).toMatchObject({ path: "/synthetic/feature work/api", reason: "Uncommitted changes" });
    expect(actions[1]?.reason).toContain("local changes");
  });

  it("ranks independent actions consistently and omits archived item actions", () => {
    const sections: LsSections = {
      items: [view(item({ id: 2 }), [pr()]), view(item({ id: 3, archived_at: AT }), [pr({ ci_state: "ERROR" })])],
      unlinked: [viewPr(pr({ id: 3, number: 31, ci_state: "FAILURE" }), CFG)], release: [],
      worktrees: { untracked: [{ wt: wt({ dirty: -1 }), stage: "unknown", pr: undefined }], housekeeping: [] },
    };
    const actions = nextActions(sections);
    expect(actions.map((a) => a.kind)).toEqual(["unknown-local-state", "ci-failing", "ready-to-merge"]);
    expect(actions.some((a) => a.item_id === 3)).toBe(false);
    expect(nextActions(sections)).toEqual(actions);
  });

  it("does not turn closed PR failures into work", () => {
    expect(prActions(viewPr(pr({ state: "CLOSED", ci_state: "FAILURE", unresolved_bot_threads: 4 }), CFG))).toEqual([]);
  });
});

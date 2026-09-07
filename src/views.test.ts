import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import { collect, jsonSections, viewItem, worktreeViews } from "./views.js";
import { itemActions, nextActions } from "./actions.js";
import { API, WEB, OTHER, CFG, AT, insertItem, insertPr, insertWt } from "./__fixtures__/model.js";
import { addTask, completeTask, updateItem } from "./store.js";
import { renderDrawer, renderPage } from "./web/render.js";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

it("keeps released work on main and preserves verification through production confirmation", () => {
  let owned = insertItem(db);
  for (const [id, repo, ci_state] of [[1, API, "SUCCESS"], [2, WEB, "FAILURE"]] as const) {
    insertPr(db, { id, repo, item_id: owned.id, state: "MERGED", merge_sha: `merge-${id}`, on_dev: 1, on_prod: 1, ci_state });
  }
  let view = viewItem(db, CFG, owned);
  expect(view.stage).toBe("needs-prod-deploy");
  expect(itemActions(view).map((a) => a.kind)).toEqual(["needs-testing", "needs-prod-deploy"]);
  const html = renderPage(collect(db, CFG), { projects: ["alpha"], syncedAt: AT });
  const column = (title: string) => html.split(`<h3>${title}</h3>`)[1]!.split('<h3>')[0]!;
  expect(column("On main")).toContain(owned.title);
  expect(column("In develop")).not.toContain(owned.title);
  const drawer = renderDrawer(view, [], []);
  expect(drawer).toContain(`data-deployed="${owned.id}"`);
  expect(drawer).toContain("Prod branch</th>");

  owned = updateItem(db, owned.id, { prod_deployed_at: AT });
  view = viewItem(db, CFG, owned);
  expect(view.stage).toBe("needs-post-deploy");
  expect(itemActions(view).some((a) => a.kind === "needs-testing")).toBe(true);

  const test = addTask(db, owned.id, "test", "Verify production behavior");
  expect(viewItem(db, CFG, owned).stage).toBe("needs-post-deploy");
  completeTask(db, test.id);
  view = viewItem(db, CFG, owned);
  expect(view.stage).toBe("done");
  expect(itemActions(view)).toEqual([]);

  db.prepare("UPDATE tasks SET completion_evidence = NULL WHERE id = ?").run(test.id);
  view = viewItem(db, CFG, owned);
  expect(view.stage).toBe("needs-post-deploy");
  expect(itemActions(view).some((a) => a.kind === "needs-testing")).toBe(true);
});

describe("project-scoped cached views", () => {
  it("filters items, releases, unlinked PRs, and both worktree sections together", () => {
    for (const [offset, project, repo] of [[0, "alpha", API], [10, "beta", OTHER]] as const) {
      insertItem(db, { id: offset + 1, project });
      insertPr(db, { id: offset + 1, number: 1, repo, item_id: offset + 1 });
      insertPr(db, { id: offset + 2, number: 2, repo, head_branch: "develop", base_branch: "main" });
      insertPr(db, { id: offset + 3, number: 3, repo, head_branch: "feature/orphan" });
      insertPr(db, { id: offset + 4, number: 4, repo, state: "MERGED", merge_sha: "merged", in_release_pr: 2 });
      insertWt(db, { repo, path: `/synthetic/${project}/loose`, branch: "feature/loose", unpushed: 1 });
      insertWt(db, { repo, path: `/synthetic/${project}/empty`, branch: "feature/empty", ahead_of_dev: 0 });
    }
    const sections = collect(db, CFG, { project: "alpha" });
    expect(sections.items.map((v) => v.item.id)).toEqual([1]);
    expect(sections.release.map((v) => [v.view.pr.repo, v.contains])).toEqual([[API, 1]]);
    expect(sections.unlinked.map((v) => [v.pr.repo, v.pr.number])).toEqual([[API, 3]]);
    expect(sections.worktrees.untracked.map((v) => v.wt.repo)).toEqual([API]);
    expect(sections.worktrees.housekeeping.map((v) => v.wt.repo)).toEqual([API]);
    expect(collect(db, CFG, { project: "unknown" })).toEqual({
      items: [], release: [], unlinked: [], worktrees: { untracked: [], housekeeping: [] },
    });
  });

  it("never lets the same silo name attach worktrees from another project", () => {
    const owned = insertItem(db, { silo: "shared" });
    insertWt(db, { repo: API, unpushed: 1 });
    insertWt(db, { repo: OTHER, path: "/synthetic/beta/shared/other", unpushed: 1 });
    expect(viewItem(db, CFG, owned).worktrees.map((v) => v.wt.repo)).toEqual([API]);
    expect(collect(db, CFG).worktrees.untracked.map((v) => v.wt.repo)).toEqual([OTHER]);
  });

  it("archived silo and PR ownership cannot hide new local work", () => {
    insertItem(db, { silo: "shared", archived_at: AT });
    insertPr(db, { item_id: 1 });
    insertWt(db, { dirty: 1 });
    const sections = collect(db, CFG, { attention: true });
    expect(sections.items).toEqual([]);
    expect(sections.worktrees.untracked.map((v) => v.wt.path)).toEqual(["/synthetic/feature work/api"]);
    const json = jsonSections(sections);
    expect(json.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "local-only", item_id: null })]));
  });

  it("attention retains draft CI failures, waiting PR failures, and unknown local state", () => {
    insertItem(db);
    insertPr(db, { item_id: 1, is_draft: 1, ci_state: "FAILURE" });
    insertPr(db, { id: 2, number: 2, head_branch: "feature/orphan", review_round: 0, bot_reviews_on_head: 0, ci_state: "ERROR" });
    insertWt(db, { branch: "feature/unknown", dirty: -1 });
    const sections = collect(db, CFG, { attention: true });
    expect(sections.items.map((v) => v.stage)).toEqual(["drafting"]);
    expect(sections.unlinked.map((v) => v.stage)).toEqual(["awaiting-review"]);
    expect(sections.worktrees.untracked.map((v) => v.stage)).toEqual(["unknown"]);
    expect(sections.worktrees.housekeeping).toEqual([]);
  });

  it("keeps ignored authors out unless explicitly requested", () => {
    insertPr(db, { author: "dependency-bot", ci_state: "FAILURE" });
    expect(collect(db, CFG, { attention: true }).unlinked).toEqual([]);
    expect(collect(db, CFG, { attention: true, all: true }).unlinked).toHaveLength(1);
  });
});


describe("main checkout local work", () => {
  it.each([
    { dirty: 1 as const },
    { unpushed: 2 },
    { dirty: -1 as const, ahead_of_dev: -1, unpushed: -1 },
  ])("keeps main local or unknown state visible without a PR: %j", (state) => {
    insertWt(db, { path: "/synthetic/api", is_main: 1, silo: "", ...state });
    const sections = collect(db, CFG, { attention: true });
    expect(sections.worktrees.untracked.map((v) => v.wt.path)).toEqual(["/synthetic/api"]);
    expect(nextActions(sections)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/synthetic/api", item_id: null }),
    ]));
    expect(sections.worktrees.housekeeping).toEqual([]);
  });

  it("keeps dirty main work visible when its PR is unlinked", () => {
    insertPr(db);
    insertWt(db, { path: "/synthetic/api", is_main: 1, silo: "", dirty: 1 });
    const sections = collect(db, CFG, { attention: true });
    expect(sections.worktrees.untracked).toHaveLength(1);
    expect(sections.worktrees.untracked[0]?.stage).toBe("local-only");
  });

  it.each([
    { dirty: 1 as const, kind: "local-only" },
    { unpushed: 2, kind: "local-only" },
    { dirty: -1 as const, kind: "unknown-local-state" },
  ])("attaches main work to its explicitly linked item and gates merge actions: %j", ({ kind, ...state }) => {
    const item = insertItem(db);
    insertPr(db, { item_id: item.id });
    insertWt(db, { path: "/synthetic/api", is_main: 1, silo: "", ...state });
    const view = viewItem(db, CFG, item);
    expect(view.worktrees.map((v) => v.wt.path)).toEqual(["/synthetic/api"]);
    expect(view.stage).toBe("ready-to-merge"); // Lifecycle remains separate from local action evidence.
    const actions = itemActions(view);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind, item_id: item.id }),
      expect.objectContaining({ kind: "merge-prerequisite", item_id: item.id }),
    ]));
    expect(actions.some((action) => action.kind === "ready-to-merge")).toBe(false);
    expect(collect(db, CFG, { attention: true }).worktrees.untracked).toEqual([]);
  });

  it("cannot hide main work through a silo claim or archived PR owner", () => {
    insertItem(db, { silo: "shared" });
    insertItem(db, { id: 2, archived_at: AT });
    insertPr(db, { item_id: 2 });
    insertWt(db, { path: "/synthetic/api", is_main: 1, dirty: 1 });
    const sections = collect(db, CFG, { attention: true });
    expect(sections.items).toEqual([]);
    expect(sections.worktrees.untracked.map((v) => v.wt.path)).toEqual(["/synthetic/api"]);
  });

  it("never offers clean main checkouts as housekeeping", () => {
    insertWt(db, { path: "/synthetic/api", is_main: 1, silo: "", ahead_of_dev: 0 });
    expect(worktreeViews(db, CFG)).toEqual([]);
    expect(collect(db, CFG).worktrees.housekeeping).toEqual([]);
    insertPr(db, { state: "MERGED", merge_sha: "merge-a" });
    expect(worktreeViews(db, CFG)).toEqual([]);
    expect(collect(db, CFG).worktrees.housekeeping).toEqual([]);
  });
});

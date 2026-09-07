import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import { captureEvidence, evidenceMatches, manualDeployCoversCurrentPrs, testsPassForCurrentPrs } from "./evidence.js";
import { addTask, completeTask, createItem, findPr, getItem, linkPr, prsForItem, tasksForItem, unlinkPr, updateItem } from "./store.js";
import { itemStage } from "./stage.js";
import type { Config, ItemRow, PrRow } from "./types.js";

const cfg: Config = {
  gating_bots: [], ignored_authors: [],
  projects: [{ name: "synthetic", repos: [{ owner: "example", name: "app", dev_branch: "develop", prod_branch: "main", deploy: "manual" }] }],
};
let db: Db;
let item: ItemRow;

beforeEach(() => {
  db = openDb(":memory:");
  item = createItem(db, { project: "synthetic", title: "Synthetic change" });
});
afterEach(() => db.close());

function insertPr(number = 1): PrRow {
  db.prepare(`INSERT INTO prs (repo, number, head_sha, merge_sha, state, base_branch, on_dev, on_prod)
    VALUES ('example/app', ?, ?, ?, 'MERGED', 'develop', 1, 0)`)
    .run(number, `head-${number}`, `merge-${number}`);
  const pr = findPr(db, "example/app", number)!;
  linkPr(db, item.id, pr.id);
  return pr;
}

function passedTest() {
  return completeTask(db, addTask(db, item.id, "test", "Smoke test passed").id);
}

describe("commit evidence", () => {
  it("stores versioned, order-independent evidence and ignores closed PRs", () => {
    insertPr(2);
    insertPr(1);
    const prs = prsForItem(db, item.id);
    const closed = { ...prs[0]!, number: 3, state: "CLOSED" as const };
    const evidence = captureEvidence(prs);
    expect(JSON.parse(evidence!).version).toBe(1);
    expect(evidenceMatches(evidence, [...prs].reverse())).toBe(true);
    expect(evidenceMatches(evidence, [...prs, closed])).toBe(true);
  });

  it("rejects absent, malformed, empty-set and unknown-commit evidence", () => {
    const pr = insertPr();
    expect(captureEvidence([])).toBeNull();
    expect(captureEvidence([{ ...pr, head_sha: "" }])).toBeNull();
    expect(captureEvidence([{ ...pr, merge_sha: null }])).toBeNull();
    for (const evidence of [undefined, null, "", "junk", "{}", '{"version":2}']) {
      expect(evidenceMatches(evidence, [pr])).toBe(false);
    }
  });

  it("requires all tests, not a single completed or legacy test", () => {
    insertPr();
    const prs = prsForItem(db, item.id);
    expect(testsPassForCurrentPrs([], prs)).toBe(false);
    const pass = passedTest();
    expect(testsPassForCurrentPrs([pass], prs)).toBe(true);
    expect(testsPassForCurrentPrs([{ ...pass, completion_evidence: null }], prs)).toBe(false);
    const pending = addTask(db, item.id, "test", "Regression still failing");
    expect(testsPassForCurrentPrs(tasksForItem(db, item.id), prs)).toBe(false);
    completeTask(db, pending.id);
    expect(testsPassForCurrentPrs(tasksForItem(db, item.id), prs)).toBe(true);
    addTask(db, item.id, "flag", "Enable after deployment");
    expect(testsPassForCurrentPrs(tasksForItem(db, item.id), prs)).toBe(true);
  });

  it.each(["head_sha", "merge_sha"])("invalidates tests when %s changes and allows explicit reconfirmation", (column) => {
    insertPr();
    const test = passedTest();
    db.prepare(`UPDATE prs SET ${column} = ?`).run("new-commit");
    const prs = prsForItem(db, item.id);
    expect(testsPassForCurrentPrs([test], prs)).toBe(false);
    expect(itemStage(item, prs, [test], cfg)).toBe("needs-testing");
    expect(testsPassForCurrentPrs([completeTask(db, test.id)], prs)).toBe(true);
  });

  it("invalidates tests and deployment evidence when active PR membership changes", () => {
    const first = insertPr();
    const test = passedTest();
    const deployed = updateItem(db, item.id, { prod_deployed_at: "2026-09-04T10:00:00Z" });
    expect(manualDeployCoversCurrentPrs(deployed, prsForItem(db, item.id))).toBe(true);
    insertPr(2);
    expect(testsPassForCurrentPrs([test], prsForItem(db, item.id))).toBe(false);
    expect(manualDeployCoversCurrentPrs(deployed, prsForItem(db, item.id))).toBe(false);
    const retested = completeTask(db, test.id);
    const redeployed = updateItem(db, item.id, { prod_deployed_at: "2026-09-04T11:00:00Z" });
    unlinkPr(db, first.id);
    expect(testsPassForCurrentPrs([retested], prsForItem(db, item.id))).toBe(false);
    expect(manualDeployCoversCurrentPrs(redeployed, prsForItem(db, item.id))).toBe(false);
  });

  it("does not let legacy deployment timestamps certify current work", () => {
    insertPr();
    db.prepare("UPDATE prs SET on_prod = 1").run();
    const test = passedTest();
    db.prepare("UPDATE items SET prod_deployed_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(item.id);
    const legacy = getItem(db, item.id)!;
    const prs = prsForItem(db, item.id);
    expect(legacy.prod_deploy_evidence).toBeNull();
    expect(itemStage(legacy, prs, [test], cfg)).toBe("needs-prod-deploy");
    const confirmed = updateItem(db, item.id, { prod_deployed_at: "2026-09-04T10:00:00Z" });
    expect(itemStage(confirmed, prs, [test], cfg)).toBe("done");
    const cleared = updateItem(db, item.id, { prod_deployed_at: null });
    expect(cleared.prod_deploy_evidence).toBeNull();
    expect(itemStage(cleared, prs, [test], cfg)).toBe("needs-prod-deploy");
  });

  it("does not refresh deployment evidence on unrelated item edits", () => {
    insertPr();
    const deployed = updateItem(db, item.id, { prod_deployed_at: "2026-09-04T10:00:00Z" });
    db.prepare("UPDATE prs SET head_sha = 'new-head'").run();
    const renamed = updateItem(db, item.id, { title: "Renamed" });
    expect(renamed.prod_deploy_evidence).toBe(deployed.prod_deploy_evidence);
    expect(manualDeployCoversCurrentPrs(renamed, prsForItem(db, item.id))).toBe(false);
  });

  it("completions before any PR exists cannot certify subsequently linked work", () => {
    const test = passedTest();
    const deployed = updateItem(db, item.id, { prod_deployed_at: "2026-09-04T10:00:00Z" });
    expect(test.completion_evidence).toBeNull();
    expect(deployed.prod_deploy_evidence).toBeNull();
    insertPr();
    expect(testsPassForCurrentPrs([test], prsForItem(db, item.id))).toBe(false);
    expect(manualDeployCoversCurrentPrs(deployed, prsForItem(db, item.id))).toBe(false);
  });

  it("tests completed before merging do not certify the later merge commit", () => {
    insertPr();
    db.prepare("UPDATE prs SET state = 'OPEN', merge_sha = NULL, on_dev = 0").run();
    const beforeMerge = passedTest();
    expect(testsPassForCurrentPrs([beforeMerge], prsForItem(db, item.id))).toBe(true);
    db.prepare("UPDATE prs SET state = 'MERGED', merge_sha = 'merge-result', on_dev = 1").run();
    const merged = prsForItem(db, item.id);
    expect(testsPassForCurrentPrs([beforeMerge], merged)).toBe(false);
    expect(itemStage(item, merged, [beforeMerge], cfg)).toBe("needs-testing");
  });
});

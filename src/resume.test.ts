import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "./db.js";
import { captureEvidence } from "./evidence.js";
import { buildResume, formatResume } from "./resume.js";
import { beginSync, finishSync } from "./sync-health.js";
import { API, WEB, CFG, AT, insertItem, insertPr, insertWt } from "./__fixtures__/model.js";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-01T12:00:00Z")); });
afterEach(() => { db.close(); vi.useRealTimers(); });

describe("portable cached resume briefs", () => {
  it("returns no briefing for a missing item", () => {
    expect(buildResume(db, CFG, 404)).toBeUndefined();
  });

  it("reopens stale test evidence and exposes exact cached paths, commits, notes, and source health", () => {
    insertItem(db, { silo: "shared", prod_deployed_at: AT });
    const oldPr = insertPr(db, { item_id: 1, state: "MERGED", merge_sha: "merge-old", on_dev: 1, on_prod: 1 });
    const evidence = captureEvidence([oldPr]);
    db.prepare(`UPDATE items SET prod_deploy_evidence = ? WHERE id = 1`).run(evidence);
    db.prepare(`INSERT INTO tasks (id, item_id, kind, text, done_at, completion_evidence) VALUES (1, 1, 'test', 'Check the invoice total', ?, ?)`).run(AT, evidence);
    db.prepare(`INSERT INTO tasks (id, item_id, kind, text) VALUES (2, 1, 'env', 'Set SYNTHETIC_MODE')`).run();
    db.prepare(`INSERT INTO tasks (id, item_id, kind, text, done_at) VALUES (3, 1, 'other', 'Completed chore', ?)`).run(AT);
    db.prepare(`UPDATE prs SET head_sha = 'head-new', merge_sha = 'merge-new' WHERE id = 1`).run();
    insertWt(db, { path: "/synthetic/spaces and 'quotes'/api", head_sha: "head-new", ahead_of_dev: 0 });
    for (let n = 1; n <= 14; n++) {
      db.prepare(`INSERT INTO events (item_id, at, source, text) VALUES (1, ?, 'user', ?)`).run(AT, `Decision ${n}`);
    }
    beginSync(db, API, "github", AT);
    finishSync(db, API, "github", [], AT);
    beginSync(db, API, "github", "2026-09-01T11:00:00Z");
    finishSync(db, API, "github", ["Synthetic API outage"]);
    beginSync(db, API, "worktrees", AT);
    finishSync(db, API, "worktrees", [], AT);
    beginSync(db, WEB, "github", "2026-09-01T12:00:00Z");
    finishSync(db, WEB, "github", []);

    const brief = buildResume(db, CFG, 1)!;
    expect(brief.tests_current).toBe(false);
    expect(brief.manual_deploy_current).toBe(false);
    expect(brief.open_tasks).toEqual([
      { id: 1, kind: "test", text: "Check the invoice total", reconfirm: true },
      { id: 2, kind: "env", text: "Set SYNTHETIC_MODE", reconfirm: false },
    ]);
    expect(brief.worktrees[0]).toMatchObject({ path: "/synthetic/spaces and 'quotes'/api", head_sha: "head-new", seen_at: AT });
    expect(brief.prs[0]).toMatchObject({ head_sha: "head-new", merge_sha: "merge-new", synced_at: AT });
    expect(brief.recent_events.map((e) => e.text)).toEqual(Array.from({ length: 12 }, (_, n) => `Decision ${n + 3}`));
    expect(brief.health.map((h) => [h.repo, h.source, h.status])).toEqual([
      [API, "github", "failed"], [API, "worktrees", "stale"],
    ]);
    const formatted = formatResume(brief);
    expect(formatted).toContain("/synthetic/spaces and 'quotes'/api");
    expect(formatted).toContain("head head-new; merge merge-new");
    expect(formatted).toContain("(reconfirm for current commits)");
    expect(formatted).toContain("Synthetic API outage");
    expect(formatted).not.toContain("Decision 1\n");
  });

  it("does not reopen tests whose evidence matches and retains explicit blocker context", () => {
    insertItem(db, { blocked_reason: "Waiting for sample data", stage_override: "tested" });
    const current = insertPr(db, { item_id: 1 });
    db.prepare(`INSERT INTO tasks (item_id, kind, text, done_at, completion_evidence) VALUES (1, 'test', 'Inspect current UI', ?, ?)`).run(AT, captureEvidence([current]));
    const before = db.prepare(`SELECT total_changes() AS changes`).get();
    const brief = buildResume(db, CFG, 1)!;
    const text = formatResume(brief);
    expect(brief.tests_current).toBe(true);
    expect(brief.open_tasks).toEqual([]);
    expect(text).toContain("Blocker: Waiting for sample data");
    expect(text).toContain("Manual stage override: tested");
    expect(brief.health.every((h) => h.status === "never")).toBe(true);
    expect(db.prepare(`SELECT total_changes() AS changes`).get()).toEqual(before);
  });
});

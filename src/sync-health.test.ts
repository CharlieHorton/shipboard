import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import { beginSync, finishSync, readSyncHealth } from "./sync-health.js";
import type { Config } from "./types.js";

const cfg: Config = {
  gating_bots: [], ignored_authors: [], projects: [
    { name: "one", repos: [{ owner: "test", name: "api", dev_branch: "dev", prod_branch: "main",
      deploy: "manual", local: "/synthetic/api", eas: { cwd: "/synthetic/api", branch: "production" } }] },
    { name: "two", repos: [{ owner: "test", name: "web", dev_branch: "dev", prod_branch: "main", deploy: "manual" }] },
  ],
};
let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

describe("persisted sync health", () => {
  it("includes every configured source and scopes by project", () => {
    expect(readSyncHealth(db, cfg, { project: "one" }).map((h) => [h.repo, h.source, h.status])).toEqual([
      ["test/api", "github", "never"], ["test/api", "eas", "never"], ["test/api", "worktrees", "never"],
    ]);
    expect(readSyncHealth(db, cfg, { project: "missing" })).toEqual([]);
  });

  it("retains last success after failure; another source's success does not hide it", () => {
    beginSync(db, "test/api", "github", "2026-09-01T10:00:00Z");
    finishSync(db, "test/api", "github", [], "2026-09-01T10:01:00Z");
    beginSync(db, "test/api", "github", "2026-09-01T11:00:00Z");
    finishSync(db, "test/api", "github", ["HTTP 502", "compare unavailable"], "2026-09-01T11:01:00Z");
    beginSync(db, "test/web", "github", "2026-09-01T11:00:00Z");
    finishSync(db, "test/web", "github", [], "2026-09-01T11:01:00Z");
    const health = readSyncHealth(db, cfg, { now: "2026-09-01T11:02:00Z" });
    expect(health[0]).toMatchObject({ status: "failed", last_attempt_at: "2026-09-01T11:00:00Z",
      last_success_at: "2026-09-01T10:01:00Z", errors: ["HTTP 502", "compare unavailable"] });
    expect(health[3]).toMatchObject({ status: "healthy", errors: [] });
  });

  it("clears errors on recovery and ages each source independently", () => {
    beginSync(db, "test/api", "github", "2026-09-01T10:00:00Z");
    finishSync(db, "test/api", "github", ["offline"]);
    beginSync(db, "test/api", "github", "2026-09-01T11:00:00Z");
    finishSync(db, "test/api", "github", [], "2026-09-01T11:01:00Z");
    expect(readSyncHealth(db, cfg, { now: "2026-09-01T11:02:00Z" })[0]).toMatchObject({ status: "healthy", errors: [] });
    expect(readSyncHealth(db, cfg, { now: "2026-09-01T11:32:00Z" })[0]?.status).toBe("stale");
  });
});

import { homedir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import {
  otaUpdatesFor,
  parseEasJson,
  syncOtaUpdates,
  type EasClient,
  type EasGroup,
  type EasGroupDetail,
} from "./eas.js";
import type { RepoConfig } from "./types.js";

const TENANTS: RepoConfig = {
  owner: "example",
  name: "tenants",
  dev_branch: "main",
  prod_branch: "main",
  deploy: "manual",
  eas: { cwd: "~/Projects/example/tenants", branch: "production" },
};
const KEY = "example/tenants";

/** A repo with no EAS config at all. */
const API: RepoConfig = {
  owner: "example",
  name: "API",
  dev_branch: "develop",
  prod_branch: "main",
  deploy: "manual",
};

function group(over: Partial<EasGroup> & { group: string }): EasGroup {
  return {
    branch: "production",
    message: `commit ${over.group}`,
    platforms: "android, ios",
    isRollBackToEmbedded: false,
    ...over,
  };
}

class FakeEas implements EasClient {
  listCalls: { cwd: string; branch: string; limit: number }[] = [];
  viewCalls: string[] = [];
  groups: EasGroup[] = [];
  details = new Map<string, EasGroupDetail>();
  failList: string | undefined;
  failView = new Set<string>();

  async listGroups(cwd: string, branch: string, limit: number): Promise<EasGroup[]> {
    this.listCalls.push({ cwd, branch, limit });
    if (this.failList !== undefined) throw new Error(this.failList);
    return this.groups.filter((g) => g.branch === branch);
  }

  async viewGroup(_cwd: string, g: string): Promise<EasGroupDetail | undefined> {
    this.viewCalls.push(g);
    if (this.failView.has(g)) throw new Error("gh: request failed");
    return this.details.get(g);
  }

  /** Register a group plus the detail `update:view` would return for it. */
  add(id: string, detail: Partial<EasGroupDetail> & { commitSha: string }, over: Partial<EasGroup> = {}): void {
    this.groups.push(group({ group: id, ...over }));
    this.details.set(id, {
      createdAt: "2026-08-20T16:38:54.643Z",
      platforms: "android, ios",
      message: `commit ${id}`,
      ...detail,
    });
  }
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

function cached(): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ota_updates ORDER BY created_at`).all() as Record<string, unknown>[];
}

// ---------- parsing ----------

describe("parseEasJson", () => {
  it("parses a plain object and a plain array", () => {
    expect(parseEasJson(`{"currentPage":[]}`)).toEqual({ currentPage: [] });
    expect(parseEasJson(`[{"id":"a"}]`)).toEqual([{ id: "a" }]);
  });

  it("tolerates the upgrade banner eas prints before the payload", () => {
    const banner = [
      "╭──────────────────────────────────────────╮",
      "│  eas-cli update available: 23.0.0 → 23.1 │",
      "╰──────────────────────────────────────────╯",
      "",
    ].join("\n");
    expect(parseEasJson(`${banner}{"currentPage":[{"group":"g1"}]}`)).toEqual({
      currentPage: [{ group: "g1" }],
    });
    expect(parseEasJson(`${banner}[{"gitCommitHash":"abc"}]`)).toEqual([{ gitCommitHash: "abc" }]);
  });

  it("picks whichever of { or [ comes first", () => {
    expect(parseEasJson(`note\n[{"a":1}]`)).toEqual([{ a: 1 }]);
    expect(parseEasJson(`note\n{"a":[1]}`)).toEqual({ a: [1] });
  });

  it("throws when there is no JSON at all", () => {
    expect(() => parseEasJson("command not found: eas\n")).toThrow(/no JSON/);
  });
});

// ---------- syncOtaUpdates ----------

describe("syncOtaUpdates", () => {
  it("does nothing for a repo with no eas config", async () => {
    const eas = new FakeEas();
    const res = await syncOtaUpdates(db, API, eas);
    expect(res).toEqual({ seen: 0, added: 0, errors: [] });
    expect(eas.listCalls).toEqual([]);
  });

  it("caches every new group with the commit from update:view", async () => {
    const eas = new FakeEas();
    eas.add("g-new", { commitSha: "bfc4863e", createdAt: "2026-08-20T16:38:54.643Z" });
    eas.add("g-old", { commitSha: "aaa1111", createdAt: "2026-08-01T09:00:00.000Z" }, { platforms: "ios" });

    const res = await syncOtaUpdates(db, TENANTS, eas);
    expect(res).toEqual({ seen: 2, added: 2, errors: [] });
    expect(eas.listCalls).toEqual([
      { cwd: `${homedir()}/Projects/example/tenants`, branch: "production", limit: 20 },
    ]);
    expect(cached()).toEqual([
      {
        group_id: "g-old",
        repo: KEY,
        branch: "production",
        commit_sha: "aaa1111",
        created_at: "2026-08-01T09:00:00.000Z",
        message: "commit g-old",
        platforms: "android, ios",
      },
      {
        group_id: "g-new",
        repo: KEY,
        branch: "production",
        commit_sha: "bfc4863e",
        created_at: "2026-08-20T16:38:54.643Z",
        message: "commit g-new",
        platforms: "android, ios",
      },
    ]);
  });

  it("never calls update:view twice for the same group", async () => {
    const eas = new FakeEas();
    eas.add("g1", { commitSha: "sha1" });
    await syncOtaUpdates(db, TENANTS, eas);
    expect(eas.viewCalls).toEqual(["g1"]);

    eas.add("g2", { commitSha: "sha2", createdAt: "2026-08-25T10:00:00.000Z" });
    const res = await syncOtaUpdates(db, TENANTS, eas);
    expect(res).toEqual({ seen: 2, added: 1, errors: [] });
    expect(eas.viewCalls).toEqual(["g1", "g2"]); // g1 came from the cache
    expect(cached()).toHaveLength(2);
  });

  it("skips rollback groups without even viewing them", async () => {
    const eas = new FakeEas();
    eas.add("g-rollback", { commitSha: "sha-rb" }, { isRollBackToEmbedded: true });
    eas.add("g-real", { commitSha: "sha-real" });

    const res = await syncOtaUpdates(db, TENANTS, eas);
    expect(res).toMatchObject({ seen: 2, added: 1 });
    expect(eas.viewCalls).toEqual(["g-real"]);
    expect(cached().map((r) => r["group_id"])).toEqual(["g-real"]);
  });

  it("skips groups whose update has no git commit", async () => {
    const eas = new FakeEas();
    eas.groups.push(group({ group: "g-nocommit" })); // listed, but update:view returns undefined
    eas.add("g-ok", { commitSha: "sha-ok" });

    const res = await syncOtaUpdates(db, TENANTS, eas);
    expect(res).toEqual({ seen: 2, added: 1, errors: [] });
    expect(cached().map((r) => r["group_id"])).toEqual(["g-ok"]);
  });

  it("reports a failed listing without throwing", async () => {
    const eas = new FakeEas();
    eas.failList = "eas update:list: not logged in";
    const res = await syncOtaUpdates(db, TENANTS, eas);
    expect(res).toEqual({ seen: 0, added: 0, errors: ["update:list production: eas update:list: not logged in"] });
    expect(cached()).toEqual([]);
  });

  it("reports a failed view and keeps going with the other groups", async () => {
    const eas = new FakeEas();
    eas.add("g-broken", { commitSha: "x" });
    eas.add("g-fine", { commitSha: "sha-fine" });
    eas.failView.add("g-broken");

    const res = await syncOtaUpdates(db, TENANTS, eas);
    expect(res).toMatchObject({ seen: 2, added: 1 });
    expect(res.errors).toEqual(["update:view g-broken: gh: request failed"]);
    expect(cached().map((r) => r["group_id"])).toEqual(["g-fine"]);
  });
});

// ---------- otaUpdatesFor ----------

describe("otaUpdatesFor", () => {
  it("returns the repo's branch oldest → newest", async () => {
    const eas = new FakeEas();
    eas.add("g2", { commitSha: "sha2", createdAt: "2026-08-20T16:38:54.643Z" });
    eas.add("g1", { commitSha: "sha1", createdAt: "2026-08-01T09:00:00.000Z" });
    eas.add("g3", { commitSha: "sha3", createdAt: "2026-08-30T12:00:00.000Z" });
    await syncOtaUpdates(db, TENANTS, eas);
    // The "main" EAS branch also receives every push, but is not a prod deploy.
    db.prepare(
      `INSERT INTO ota_updates (group_id, repo, branch, commit_sha, created_at, message, platforms)
       VALUES ('g-main', ?, 'main', 'shaM', '2026-08-15T00:00:00.000Z', 'push', 'android')`,
    ).run(KEY);

    expect(otaUpdatesFor(db, KEY, "production").map((u) => u.group_id)).toEqual(["g1", "g2", "g3"]);
    expect(otaUpdatesFor(db, KEY, "main").map((u) => u.group_id)).toEqual(["g-main"]);
    expect(otaUpdatesFor(db, "example/API", "production")).toEqual([]);
  });
});

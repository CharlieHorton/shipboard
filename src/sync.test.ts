import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import type { EasClient, EasGroup, EasGroupDetail } from "./eas.js";
import type { CompareResult, GithubClient, PrBatch, PrNode } from "./github.js";
import { derivePrFields, syncAll, syncRepo } from "./sync.js";
import { readSyncHealth } from "./sync-health.js";
import type { Config, RepoConfig } from "./types.js";
import type { GitClient, GitResult } from "./worktrees.js";

// ---------- fixtures ----------

const FIXTURE = JSON.parse(
  readFileSync(new URL("./__fixtures__/open-prs.json", import.meta.url), "utf8"),
) as { data: { repository: { pullRequests: { nodes: PrNode[] } } } };

const FIXTURE_PRS: PrNode[] = FIXTURE.data.repository.pullRequests.nodes;

function fixturePr(number: number): PrNode {
  const pr = FIXTURE_PRS.find((n) => n.number === number);
  if (!pr) throw new Error(`fixture has no PR #${number}`);
  return structuredClone(pr);
}

const GATING = ["coderabbitai", "qodo-code-review"];

const API: RepoConfig = {
  owner: "example",
  name: "API",
  dev_branch: "develop",
  prod_branch: "main",
  deploy: "manual",
};
const MOBILE: RepoConfig = {
  owner: "example",
  name: "mobile",
  dev_branch: "main",
  prod_branch: "main",
  deploy: "manual",
};

const CFG: Config = {
  gating_bots: GATING,
  ignored_authors: ["dependabot"],
  projects: [{ name: "example", repos: [API, MOBILE] }],
};

/** A minimal open PR node; override anything. */
function node(over: Partial<PrNode> & { number: number }): PrNode {
  return {
    title: `PR ${over.number}`,
    isDraft: false,
    state: "OPEN",
    baseRefName: "develop",
    headRefName: `feature/pr-${over.number}`,
    headRefOid: `head${over.number}`,
    mergedAt: null,
    url: `https://github.com/example/API/pull/${over.number}`,
    author: { login: "example", __typename: "User" },
    mergeCommit: null,
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { oid: `head${over.number}`, statusCheckRollup: null } }] },
    ...over,
  };
}

function mergedNode(number: number, sha: string, over: Partial<PrNode> = {}): PrNode {
  return node({
    number,
    state: "MERGED",
    mergedAt: "2026-09-02T10:06:47Z",
    mergeCommit: { oid: sha },
    ...over,
  });
}

class FakeGithub implements GithubClient {
  fetchPrsCalls = 0;
  fetchPrCalls: number[] = [];
  compareCalls: string[] = [];
  batch: PrBatch;
  /** `${base}...${head}` → ahead_by. A missing key behaves like a 404. */
  compares = new Map<string, number>();
  /** PRs reachable only by number (aged out of the batch). */
  singles = new Map<number, PrNode>();
  failFetch: string | undefined;

  constructor(batch: Partial<PrBatch> = {}) {
    this.batch = { open: batch.open ?? [], merged: batch.merged ?? [] };
  }

  async fetchPrs(): Promise<PrBatch> {
    this.fetchPrsCalls += 1;
    if (this.failFetch !== undefined) throw new Error(this.failFetch);
    return this.batch;
  }

  async fetchPr(_repo: RepoConfig, number: number): Promise<PrNode | undefined> {
    this.fetchPrCalls.push(number);
    return this.singles.get(number);
  }

  async compare(_repo: RepoConfig, base: string, head: string): Promise<CompareResult> {
    const key = `${base}...${head}`;
    this.compareCalls.push(key);
    const ahead = this.compares.get(key);
    if (ahead === undefined) throw new Error("gh: Not Found (HTTP 404)");
    return { ahead_by: ahead, status: ahead === 0 ? "behind" : "diverged" };
  }
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

function linkItem(repo: string, number: number): number {
  const item = db.prepare(`INSERT INTO items (project, title) VALUES ('example', 'work item')`).run();
  const itemId = Number(item.lastInsertRowid);
  db.prepare(`UPDATE prs SET item_id = ? WHERE repo = ? AND number = ?`).run(itemId, repo, number);
  return itemId;
}

function eventTexts(itemId: number): string[] {
  return db.prepare(`SELECT text FROM events WHERE item_id = ? ORDER BY id`).all(itemId).map((r) => (r as { text: string }).text);
}

function prRow(repo: string, number: number): Record<string, unknown> {
  return db.prepare(`SELECT * FROM prs WHERE repo = ? AND number = ?`).get(repo, number) as Record<string, unknown>;
}

// ---------- derivation ----------

describe("derivePrFields (synthetic GitHub response)", () => {
  it("PR #307: four bot review rounds, none on the current head, nine unresolved threads", () => {
    const d = derivePrFields(fixturePr(307), GATING);
    // Four distinct reviewed commits precede the current head.
    expect(d.review_round).toBe(4);
    expect(d.bot_reviews_on_head).toBe(0);
    expect(d.unresolved_bot_threads).toBe(9);
    expect(d.head_sha).toBe("synthetic-head-307");
    expect(d.state).toBe("OPEN");
    expect(d.base_branch).toBe("main");
    expect(d.head_branch).toBe("develop");
    expect(d.ci_state).toBe("SUCCESS");
    expect(d.author).toBe("example");
    expect(d.merge_sha).toBeNull();
  });

  it("PR #205: coderabbit has reviewed the head, eleven unresolved threads", () => {
    const d = derivePrFields(fixturePr(205), GATING);
    // Two bots reviewing the same commit still count as one round.
    expect(d.review_round).toBe(7);
    expect(d.bot_reviews_on_head).toBe(1);
    expect(d.unresolved_bot_threads).toBe(11);
  });

  it("PR #244: one round, reviewed on head, nothing unresolved", () => {
    const d = derivePrFields(fixturePr(244), GATING);
    expect(d.review_round).toBe(1);
    expect(d.bot_reviews_on_head).toBe(1);
    expect(d.unresolved_bot_threads).toBe(0);
  });

  it("PR #88: non-gating bots (codex, greptile) do not count", () => {
    const d = derivePrFields(fixturePr(88), GATING);
    expect(d.review_round).toBe(0);
    expect(d.bot_reviews_on_head).toBe(0);
    expect(d.unresolved_bot_threads).toBe(0);
    expect(d.ci_state).toBeNull(); // statusCheckRollup is null when nothing reported
  });

  it("counts the other bots once they are configured as gating", () => {
    // greptile and codex both reviewed the single head commit → one round
    const d = derivePrFields(fixturePr(88), [...GATING, "greptile-apps", "chatgpt-codex-connector"]);
    expect(d.review_round).toBe(1);
    expect(d.bot_reviews_on_head).toBe(1);
    expect(d.unresolved_bot_threads).toBe(3); // all three threads are codex's
  });

  it("reads draft and author from the node", () => {
    const d = derivePrFields(fixturePr(143), GATING);
    expect(d.is_draft).toBe(1);
    expect(d.author).toBe("example");
  });

  it("survives null commits, authors and rollups", () => {
    const d = derivePrFields(
      node({
        number: 1,
        reviews: {
          nodes: [
            { author: { login: "coderabbitai", __typename: "Bot" }, commit: null },
            { author: null, commit: { oid: "head1" } },
            { author: { login: "coderabbitai", __typename: "Bot" }, commit: { oid: "head1" } },
          ],
        },
        reviewThreads: { nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [] } }] },
        commits: { nodes: [] },
        author: null,
      }),
      GATING,
    );
    expect(d.review_round).toBe(1);
    expect(d.bot_reviews_on_head).toBe(1);
    expect(d.unresolved_bot_threads).toBe(0);
    expect(d.ci_state).toBeNull();
    expect(d.author).toBe("");
  });

  it("derives MERGED/CLOSED state and merge_sha", () => {
    expect(derivePrFields(mergedNode(305, "sha305"), GATING)).toMatchObject({
      state: "MERGED",
      merge_sha: "sha305",
      merged_at: "2026-09-02T10:06:47Z",
    });
    expect(derivePrFields(node({ number: 9, state: "CLOSED", mergeCommit: null }), GATING)).toMatchObject({
      state: "CLOSED",
      merge_sha: null,
    });
  });
});

// ---------- syncRepo ----------

describe("syncRepo", () => {
  it("stores every PR in the batch and reports them as created", async () => {
    const gh = new FakeGithub({ open: FIXTURE_PRS });
    const res = await syncRepo(db, API, CFG, gh);

    expect(res.repo).toBe("example/API");
    expect(res.prs_seen).toBe(FIXTURE_PRS.length);
    expect(res.prs_changed).toBe(FIXTURE_PRS.length);
    expect(res.errors).toEqual([]);
    expect(res.changes.every((c) => c.field === "created")).toBe(true);
    expect(gh.compareCalls).toEqual([]); // nothing merged → no REST calls

    const row = prRow("example/API", 307);
    expect(row).toMatchObject({ review_round: 4, unresolved_bot_threads: 9, bot_reviews_on_head: 0, on_dev: 0 });
    expect(row["synced_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports nothing on a second identical sync", async () => {
    const gh = new FakeGithub({ open: FIXTURE_PRS });
    await syncRepo(db, API, CFG, gh);
    const res = await syncRepo(db, API, CFG, gh);
    expect(res.prs_changed).toBe(0);
    expect(res.changes).toEqual([]);
  });

  it("diffs the derived fields and writes events for linked PRs", async () => {
    const pr = fixturePr(244);
    const gh = new FakeGithub({ open: [pr] });
    await syncRepo(db, API, CFG, gh);
    const itemId = linkItem("example/API", 244);

    // new head pushed, coderabbit re-reviews it and opens two threads, CI fails
    const next = fixturePr(244);
    next.headRefOid = "newhead";
    next.commits = { nodes: [{ commit: { oid: "newhead", statusCheckRollup: { state: "FAILURE" } } }] };
    next.reviews = {
      nodes: [
        ...(pr.reviews?.nodes ?? []),
        { author: { login: "coderabbitai", __typename: "Bot" }, commit: { oid: "newhead" } },
      ],
    };
    next.reviewThreads = {
      nodes: [
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: "qodo-code-review" } }] } },
        { isResolved: false, isOutdated: true, comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
      ],
    };
    gh.batch = { open: [next], merged: [] };

    const res = await syncRepo(db, API, CFG, gh);
    expect(res.prs_changed).toBe(1);
    const fields = res.changes.map((c) => c.field).sort();
    expect(fields).toEqual(["ci_state", "head_sha", "review_round", "unresolved_bot_threads"]);
    expect(res.changes.find((c) => c.field === "review_round")).toMatchObject({ from: 1, to: 2, number: 244 });

    expect(eventTexts(itemId)).toEqual([
      "PR example/API#244 review round 2 landed, 2 unresolved bot threads",
      "PR example/API#244 CI FAILURE",
    ]);
  });

  it("does not write an event for a head_sha-only change", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    await syncRepo(db, API, CFG, gh);
    const itemId = linkItem("example/API", 50);

    gh.batch = { open: [node({ number: 50, headRefOid: "head50b" })], merged: [] };
    const res = await syncRepo(db, API, CFG, gh);
    expect(res.changes.map((c) => c.field)).toEqual(["head_sha"]);
    expect(eventTexts(itemId)).toEqual([]);
  });

  it("never overwrites item_id", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    await syncRepo(db, API, CFG, gh);
    const itemId = linkItem("example/API", 50);
    gh.batch = { open: [node({ number: 50, title: "renamed" })], merged: [] };
    await syncRepo(db, API, CFG, gh);
    expect(prRow("example/API", 50)).toMatchObject({ item_id: itemId, title: "renamed" });
  });

  it("fetches linked PRs that have aged out of the batch", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    await syncRepo(db, API, CFG, gh);
    const itemId = linkItem("example/API", 50);

    const old = mergedNode(50, "sha50");
    gh.singles.set(50, old);
    gh.compares.set("develop...sha50", 0);
    gh.compares.set("main...sha50", 4);
    gh.batch = { open: [node({ number: 51 })], merged: [] };

    const res = await syncRepo(db, API, CFG, gh);
    expect(gh.fetchPrCalls).toEqual([50]);
    expect(res.prs_seen).toBe(2);
    expect(prRow("example/API", 50)).toMatchObject({ state: "MERGED", on_dev: 1, on_prod: 0 });
    expect(eventTexts(itemId)).toEqual([
      "PR example/API#50 merged into develop",
      "PR example/API#50 now on dev",
    ]);
  });

  it("records an error when a linked PR cannot be fetched", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    await syncRepo(db, API, CFG, gh);
    linkItem("example/API", 50);
    gh.batch = { open: [], merged: [] };

    const res = await syncRepo(db, API, CFG, gh);
    expect(res.errors).toEqual(["PR #50: not found"]);
  });

  it("does not re-fetch unlinked merged history missing from the batch", async () => {
    const gh = new FakeGithub({ merged: [mergedNode(50, "sha50")] });
    gh.compares.set("develop...sha50", 0);
    gh.compares.set("main...sha50", 0);
    await syncRepo(db, API, CFG, gh);
    gh.batch = { open: [], merged: [] };
    const res = await syncRepo(db, API, CFG, gh);
    expect(gh.fetchPrCalls).toEqual([]);
    expect(res.prs_seen).toBe(0);
  });

  it("refreshes a missing unlinked open PR so closure cannot leave a ghost action", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    await syncRepo(db, API, CFG, gh);
    gh.batch = { open: [], merged: [] };
    gh.singles.set(50, node({ number: 50, state: "CLOSED" }));

    const result = await syncRepo(db, API, CFG, gh);
    expect(gh.fetchPrCalls).toEqual([50]);
    expect(result.errors).toEqual([]);
    expect(prRow("example/API", 50)).toMatchObject({ state: "CLOSED", item_id: null });
    expect(readSyncHealth(db, CFG)[0]?.status).toBe("healthy");

    gh.fetchPrCalls = [];
    await syncRepo(db, API, CFG, gh);
    expect(gh.fetchPrCalls).toEqual([]); // closed unlinked history needs no further refresh
  });

  it("preserves a missing unlinked open PR on not-found and reports source failure", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    await syncRepo(db, API, CFG, gh);
    const success = readSyncHealth(db, CFG)[0]?.last_success_at;
    gh.batch = { open: [], merged: [] };

    const result = await syncRepo(db, API, CFG, gh);
    expect(result.errors).toEqual(["PR #50: not found"]);
    expect(prRow("example/API", 50)).toMatchObject({ state: "OPEN", item_id: null });
    expect(readSyncHealth(db, CFG)[0]).toMatchObject({ status: "failed", last_success_at: success });
  });

  it("reports the fetch failure and leaves the DB alone", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    gh.failFetch = "gh api graphql: HTTP 502";
    const res = await syncRepo(db, API, CFG, gh);
    expect(res.errors).toEqual(["fetch PRs: gh api graphql: HTTP 502"]);
    expect(res.prs_seen).toBe(0);
    expect(prRow("example/API", 50)).toBeUndefined();
  });
});

// ---------- reachability ----------

describe("reachability", () => {
  const release = node({ number: 307, baseRefName: "main", headRefName: "develop", headRefOid: "devhead" });

  it("preserves known reachability when a later compare fails and marks GitHub unhealthy", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 26);
    gh.compares.set("devhead...sha305", 0);
    await syncRepo(db, API, CFG, gh);
    const success = readSyncHealth(db, CFG)[0]?.last_success_at;
    gh.compares.clear();
    const result = await syncRepo(db, API, CFG, gh);
    expect(result.errors).toHaveLength(2);
    expect(result.changes).toEqual([]);
    expect(prRow("example/API", 305)).toMatchObject({ on_dev: 1, on_prod: 0, in_release_pr: 307 });
    expect(readSyncHealth(db, CFG)[0]).toMatchObject({ status: "failed", last_success_at: success });
  });

  it("marks a merged PR on dev and inside the open release PR", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 26);
    gh.compares.set("devhead...sha305", 0);

    const res = await syncRepo(db, API, CFG, gh);
    expect(res.errors).toEqual([]);
    expect(prRow("example/API", 305)).toMatchObject({ on_dev: 1, on_prod: 0, in_release_pr: 307 });
    expect(gh.compareCalls).toEqual(["develop...sha305", "main...sha305", "devhead...sha305"]);
  });

  it("skips the release-PR compare when the sha is not even on dev", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 3);
    gh.compares.set("main...sha305", 26);

    await syncRepo(db, API, CFG, gh);
    expect(gh.compareCalls).toEqual(["develop...sha305", "main...sha305"]);
    expect(prRow("example/API", 305)).toMatchObject({ on_dev: 0, on_prod: 0, in_release_pr: null });
  });

  it("marks a PR merged all the way to prod", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 0);

    await syncRepo(db, API, CFG, gh);
    expect(prRow("example/API", 305)).toMatchObject({ on_dev: 1, on_prod: 1, in_release_pr: null });
  });

  it("memoises compares per (base, sha) within a run", async () => {
    const gh = new FakeGithub({
      open: [release],
      merged: [mergedNode(305, "sha305"), mergedNode(306, "sha305", { headRefName: "feature/dup" })],
    });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 26);
    gh.compares.set("devhead...sha305", 0);

    await syncRepo(db, API, CFG, gh);
    expect(gh.compareCalls.sort()).toEqual(["develop...sha305", "devhead...sha305", "main...sha305"]);
  });

  it("uses one compare when dev_branch === prod_branch", async () => {
    const gh = new FakeGithub({ merged: [mergedNode(12, "sha12", { baseRefName: "main" })] });
    gh.compares.set("main...sha12", 0);

    await syncRepo(db, MOBILE, CFG, gh);
    expect(gh.compareCalls).toEqual(["main...sha12"]);
    expect(prRow("example/mobile", 12)).toMatchObject({ on_dev: 1, on_prod: 1, in_release_pr: null });
  });

  it("stops paying for compares once on_prod is set", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 0);
    await syncRepo(db, API, CFG, gh);
    gh.compareCalls = [];

    const res = await syncRepo(db, API, CFG, gh);
    expect(gh.compareCalls).toEqual([]);
    expect(res.changes).toEqual([]);
    expect(prRow("example/API", 305)).toMatchObject({ on_dev: 1, on_prod: 1 });
  });

  it("treats an unknown sha (404) as not reachable and records the error", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    const res = await syncRepo(db, API, CFG, gh);
    expect(res.errors).toEqual([
      "compare develop...sha305: gh: Not Found (HTTP 404)",
      "compare main...sha305: gh: Not Found (HTTP 404)",
    ]);
    expect(prRow("example/API", 305)).toMatchObject({ on_dev: 0, on_prod: 0 });
  });

  it("emits release and prod events for linked PRs", async () => {
    const gh = new FakeGithub({ open: [release], merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 26);
    gh.compares.set("devhead...sha305", 0);
    await syncRepo(db, API, CFG, gh);
    const itemId = linkItem("example/API", 305);

    gh.compares.set("main...sha305", 0);
    await syncRepo(db, API, CFG, gh);
    expect(eventTexts(itemId)).toEqual(["PR example/API#305 now on prod branch"]);
  });
});

// ---------- syncAll ----------

describe("syncAll", () => {
  it("syncs every configured repo and keeps going when one fails", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    const failing: GithubClient = {
      fetchPrs: async (repo) => (repo.name === "API" ? gh.fetchPrs() : Promise.reject(new Error("boom"))),
      fetchPr: (repo, n) => gh.fetchPr(repo, n),
      compare: (repo, b, h) => gh.compare(repo, b, h),
    };

    const results = await syncAll(db, CFG, { client: failing });
    expect(results.map((r) => r.repo)).toEqual(["example/API", "example/mobile"]);
    expect(results[0]?.errors).toEqual([]);
    expect(results[0]?.prs_seen).toBe(1);
    expect(results[1]?.errors).toEqual(["fetch PRs: boom"]);
  });

  it("honours opts.repos", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    const results = await syncAll(db, CFG, { repos: ["example/API"], client: gh });
    expect(results.map((r) => r.repo)).toEqual(["example/API"]);
    expect(gh.fetchPrsCalls).toBe(1);
  });
});

// ---------- OTA (Expo EAS) deploys ----------

/** The mobile app as it is really configured: one branch, plus OTA updates. */
const MOBILE_OTA: RepoConfig = { ...MOBILE, eas: { cwd: "/checkout", branch: "production" } };
const MOBILE_KEY = "example/mobile";

class FakeEas implements EasClient {
  listCalls = 0;
  viewCalls: string[] = [];
  groups: EasGroup[] = [];
  details = new Map<string, EasGroupDetail>();
  failList: string | undefined;

  /** `id` publishes `commitSha` at `createdAt`. Newest first, as eas returns them. */
  add(id: string, commitSha: string, createdAt: string, platforms = "android, ios"): this {
    this.groups.unshift({ group: id, branch: "production", message: `msg ${id}`, platforms, isRollBackToEmbedded: false });
    this.details.set(id, { commitSha, createdAt, platforms, message: `msg ${id}` });
    return this;
  }

  async listGroups(_cwd: string, branch: string): Promise<EasGroup[]> {
    this.listCalls += 1;
    if (this.failList !== undefined) throw new Error(this.failList);
    return this.groups.filter((g) => g.branch === branch);
  }

  async viewGroup(_cwd: string, group: string): Promise<EasGroupDetail | undefined> {
    this.viewCalls.push(group);
    return this.details.get(group);
  }
}

/** Compares issued to test OTA containment (base = an update's commit). */
function otaCompares(gh: FakeGithub): string[] {
  return gh.compareCalls.filter((c) => c.startsWith("ota"));
}

describe("OTA deploys", () => {
  const MERGE_SHA = "bfc4863e";

  function mobileGh(): FakeGithub {
    const gh = new FakeGithub({ merged: [mergedNode(5, MERGE_SHA, { baseRefName: "main" })] });
    gh.compares.set(`main...${MERGE_SHA}`, 0);
    return gh;
  }

  it("does not invent a first deployment when an older update compare fails", async () => {
    const gh = mobileGh();
    const eas = new FakeEas().add("g-old", "ota1", "2026-08-20T16:38:54.643Z")
      .add("g-new", "ota2", "2026-08-27T09:00:00.000Z");
    gh.compares.set(`ota2...${MERGE_SHA}`, 0);
    const result = await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(result.errors).toContain(`compare ota1...${MERGE_SHA.slice(0, 7)}: gh: Not Found (HTTP 404)`);
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({ deployed_at: null, deploy_ref: null });
  });

  it("marks the PR deployed by the OLDEST update that contains its merge commit", async () => {
    const gh = mobileGh();
    const eas = new FakeEas()
      .add("g-old", "ota1", "2026-08-20T16:38:54.643Z", "android")
      .add("g-new", "ota2", "2026-08-27T09:00:00.000Z");
    gh.compares.set(`ota1...${MERGE_SHA}`, 0);
    gh.compares.set(`ota2...${MERGE_SHA}`, 0);

    const res = await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(res.errors).toEqual([]);
    expect(eas.listCalls).toBe(1);
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({
      deployed_at: "2026-08-20T16:38:54.643Z",
      deploy_ref: "g-old",
      on_prod: 1,
    });
    // newest first, then one step back; the walk stops when it runs out of updates
    expect(otaCompares(gh)).toEqual([`ota2...${MERGE_SHA}`, `ota1...${MERGE_SHA}`]);
  });

  it("stops after one compare when the newest update does not contain the merge commit", async () => {
    const gh = mobileGh();
    const eas = new FakeEas()
      .add("g-old", "ota1", "2026-08-20T16:38:54.643Z")
      .add("g-new", "ota2", "2026-08-27T09:00:00.000Z");
    gh.compares.set(`ota1...${MERGE_SHA}`, 0); // never asked
    gh.compares.set(`ota2...${MERGE_SHA}`, 3);

    await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({ deployed_at: null, deploy_ref: null });
    expect(otaCompares(gh)).toEqual([`ota2...${MERGE_SHA}`]);
  });

  it("takes the newest update when the one before it predates the merge", async () => {
    const gh = mobileGh();
    const eas = new FakeEas()
      .add("g-old", "ota1", "2026-08-20T16:38:54.643Z")
      .add("g-new", "ota2", "2026-08-27T09:00:00.000Z");
    gh.compares.set(`ota1...${MERGE_SHA}`, 4);
    gh.compares.set(`ota2...${MERGE_SHA}`, 0);

    await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({
      deployed_at: "2026-08-27T09:00:00.000Z",
      deploy_ref: "g-new",
    });
  });

  it("keeps a stored deploy even when the OTA cache no longer explains it", async () => {
    const gh = mobileGh();
    const eas = new FakeEas().add("g-old", "ota1", "2026-08-20T16:38:54.643Z");
    gh.compares.set(`ota1...${MERGE_SHA}`, 0);
    await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    gh.compareCalls = [];
    db.prepare(`DELETE FROM ota_updates`).run();

    const res = await syncRepo(db, MOBILE_OTA, CFG, gh, new FakeEas());
    expect(res.changes).toEqual([]);
    expect(gh.compareCalls).toEqual([]); // once shipped, nothing is recomputed
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({
      deployed_at: "2026-08-20T16:38:54.643Z",
      deploy_ref: "g-old",
    });
  });

  it("writes a shipped event when deployed_at flips from null", async () => {
    const gh = mobileGh();
    await syncRepo(db, MOBILE_OTA, CFG, gh, new FakeEas());
    const itemId = linkItem(MOBILE_KEY, 5);

    const eas = new FakeEas().add("g-old", "ota1", "2026-08-20T16:38:54.643Z");
    gh.compares.set(`ota1...${MERGE_SHA}`, 0);
    const res = await syncRepo(db, MOBILE_OTA, CFG, gh, eas);

    expect(res.changes).toEqual([
      { repo: MOBILE_KEY, number: 5, field: "deployed_at", from: null, to: "2026-08-20T16:38:54.643Z" },
    ]);
    expect(eventTexts(itemId)).toEqual([
      "PR example/mobile#5 shipped via OTA production (android, ios)",
    ]);
  });

  it("only considers updates on the configured EAS branch", async () => {
    const gh = mobileGh();
    const eas = new FakeEas().add("g-prod", "ota1", "2026-08-20T16:38:54.643Z");
    // "main" also receives an OTA update on every push; it is not a prod deploy.
    eas.groups.unshift({ group: "g-main", branch: "main", message: "push", platforms: "android", isRollBackToEmbedded: false });
    eas.details.set("g-main", { commitSha: "otaM", createdAt: "2026-08-26T00:00:00.000Z", platforms: "android", message: "push" });
    gh.compares.set(`ota1...${MERGE_SHA}`, 0);
    gh.compares.set(`otaM...${MERGE_SHA}`, 0);

    await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(eas.viewCalls).toEqual(["g-prod"]);
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({ deploy_ref: "g-prod" });
  });

  it("does not look for a deploy for an unmerged PR", async () => {
    const gh = new FakeGithub({ open: [node({ number: 6, baseRefName: "main" })] });
    const eas = new FakeEas().add("g-old", "ota1", "2026-08-20T16:38:54.643Z");

    await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(gh.compareCalls).toEqual([]);
    expect(prRow(MOBILE_KEY, 6)).toMatchObject({ deployed_at: null, deploy_ref: null });
  });

  it("reports an eas failure under an `eas:` prefix and syncs the rest", async () => {
    const gh = mobileGh();
    const eas = new FakeEas();
    eas.failList = "eas update:list: not logged in";

    const res = await syncRepo(db, MOBILE_OTA, CFG, gh, eas);
    expect(res.errors).toEqual(["eas: update:list production: eas update:list: not logged in"]);
    expect(res.prs_seen).toBe(1);
    expect(prRow(MOBILE_KEY, 5)).toMatchObject({ on_prod: 1, deployed_at: null });
  });

  it("never touches eas for a repo without an eas config", async () => {
    const gh = new FakeGithub({ merged: [mergedNode(305, "sha305")] });
    gh.compares.set("develop...sha305", 0);
    gh.compares.set("main...sha305", 0);
    const eas = new FakeEas().add("g-old", "ota1", "2026-08-20T16:38:54.643Z");

    await syncRepo(db, API, CFG, gh, eas);
    expect(eas.listCalls).toBe(0);
    expect(prRow("example/API", 305)).toMatchObject({ deployed_at: null });
  });
});

// ---------- local worktrees ----------

const API_LOCAL: RepoConfig = { ...API, local: "/checkout/API" };
const LOCAL_CFG: Config = { ...CFG, projects: [{ name: "example", repos: [API_LOCAL] }] };

/** Two worktrees, neither on origin: the main checkout and one silo branch. */
class FakeGit implements GitClient {
  calls: string[] = [];
  failFetch = false;

  async run(cwd: string, args: string[]): Promise<GitResult> {
    this.calls.push(`${cwd} :: ${args.join(" ")}`);
    switch (args[0]) {
      case "fetch":
        return { code: this.failFetch ? 1 : 0, stdout: "" };
      case "worktree":
        return {
          code: 0,
          stdout:
            "worktree /checkout/API\nHEAD sha-main\nbranch refs/heads/develop\n\n" +
            "worktree /features/sample-feature/API\nHEAD sha-sample-feature\nbranch refs/heads/feature/sample-feature\n",
        };
      case "status":
        return { code: 0, stdout: "" };
      case "rev-parse":
        return { code: 1, stdout: "" }; // no origin/<branch>
      case "rev-list":
        return { code: 0, stdout: "2\n" };
      case "log":
        return { code: 0, stdout: "2026-09-01T10:00:00+01:00\n" };
      default:
        return { code: 1, stdout: "" };
    }
  }
}

function worktreeRows(): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM worktrees ORDER BY path`).all() as Record<string, unknown>[];
}

describe("worktree tracking", () => {
  it("refreshes local worktrees and EAS despite a GitHub fetch failure", async () => {
    const repo = { ...API_LOCAL, eas: { cwd: "/synthetic", branch: "production" } };
    const cfg = { ...CFG, projects: [{ name: "example", repos: [repo] }] };
    const gh = new FakeGithub();
    gh.failFetch = "offline";
    const eas = new FakeEas();
    const result = await syncRepo(db, repo, cfg, gh, eas, new FakeGit());
    expect(result.errors).toEqual(["fetch PRs: offline"]);
    expect(result.worktrees_seen).toBe(2);
    expect(eas.listCalls).toBe(1);
    expect(readSyncHealth(db, cfg).map((h) => [h.source, h.status])).toEqual([
      ["github", "failed"], ["eas", "healthy"], ["worktrees", "healthy"],
    ]);
  });

  it("records the local worktrees of a repo with a checkout", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    const git = new FakeGit();

    const res = await syncRepo(db, API_LOCAL, CFG, gh, new FakeEas(), git);

    expect(res.errors).toEqual([]);
    expect(res.prs_seen).toBe(1);
    expect(res.worktrees_seen).toBe(2);
    expect(worktreeRows()).toMatchObject([
      { path: "/checkout/API", branch: "develop", silo: "", is_main: 1 },
      { path: "/features/sample-feature/API", branch: "feature/sample-feature", silo: "sample-feature", is_main: 0, unpushed: 2 },
    ]);
  });

  it("never runs git for a repo without a local checkout", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    const git = new FakeGit();

    const res = await syncRepo(db, API, CFG, gh, new FakeEas(), git);

    expect(git.calls).toEqual([]);
    expect(res.worktrees_seen).toBe(0);
    expect(worktreeRows()).toEqual([]);
  });

  it("folds worktree failures into the repo's errors", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    const git = new FakeGit();
    git.failFetch = true;

    const res = await syncRepo(db, API_LOCAL, CFG, gh, new FakeEas(), git);

    expect(res.errors).toEqual(["worktrees: fetch origin failed (exit 1); commit comparisons unavailable"]);
    expect(res.worktrees_seen).toBe(2); // the local scan still runs
  });

  it("syncAll hands its git client through", async () => {
    const gh = new FakeGithub({ open: [node({ number: 50 })] });
    const git = new FakeGit();

    const results = await syncAll(db, LOCAL_CFG, { client: gh, git });

    expect(results[0]?.worktrees_seen).toBe(2);
    expect(git.calls[0]).toBe("/checkout/API :: fetch --quiet origin");
  });
});

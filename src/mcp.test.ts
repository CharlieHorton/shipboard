import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TEST_CONFIG } from "./__fixtures__/config.js";
import { openDb, type Db } from "./db.js";
import { createServer } from "./mcp.js";
import type { Config, WorktreeRow } from "./types.js";

const API = "example/API";

let db: Db;
let client: Client;
const closers: (() => Promise<void>)[] = [];

/** A client wired to a fresh server over an in-process transport pair. */
async function start(cfg: Config = TEST_CONFIG): Promise<Client> {
  const server = createServer(db, cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "shipboard-test", version: "0" });
  await Promise.all([c.connect(clientTransport), server.connect(serverTransport)]);
  closers.push(async () => {
    await c.close();
    await server.close();
  });
  return c;
}

beforeEach(async () => {
  db = openDb(":memory:");
  client = await start();
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  db.close();
});

/** PRs are written by the sync engine; tests insert them by hand. */
function insertPr(repo: string, number: number, head: string, base = "develop"): void {
  db.prepare("INSERT INTO prs (repo, number, head_branch, base_branch, state) VALUES (?,?,?,?,'OPEN')").run(
    repo,
    number,
    head,
    base,
  );
}

/** Worktrees are written by the sync engine; tests insert them by hand. */
function insertWorktree(over: Partial<WorktreeRow> & { path: string; branch: string }): void {
  const row: WorktreeRow = {
    repo: API,
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

interface Reply {
  isError: boolean;
  text: string;
}

async function call(name: string, args: Record<string, unknown> = {}, c: Client = client): Promise<Reply> {
  const res = await c.callTool({ name, arguments: args });
  const content = res.content as { text: string }[] | undefined;
  return { isError: res.isError === true, text: (content ?? []).map((p) => p.text).join("") };
}

async function json<T>(name: string, args: Record<string, unknown> = {}, c: Client = client): Promise<T> {
  const r = await call(name, args, c);
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text) as T;
}

interface ItemJson {
  id: number;
  title: string;
  summary: string | null;
  changes: string[];
  repo_order: string[];
  stage: string;
  stage_override: string | null;
  blocked_reason: string | null;
  prod_deployed_at: string | null;
  prs: { repo: string; number: number; stage: string }[];
  silo: string | null;
  worktrees: WorktreeJson[];
}

interface WorktreeJson {
  path: string;
  repo: string;
  branch: string;
  silo: string;
  stage: string;
  pr_number: number | null;
}

const TOOL_NAMES = [
  "shipboard_add_task",
  "shipboard_complete_task",
  "shipboard_get",
  "shipboard_link_pr",
  "shipboard_list",
  "shipboard_lookup_branch",
  "shipboard_next",
  "shipboard_note",
  "shipboard_resume",
  "shipboard_set",
  "shipboard_sync",
  "shipboard_upsert_item",
  "shipboard_worktrees",
];

it("registers every tool", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
  for (const t of tools) expect(t.description ?? "").not.toBe("");
});

it("offers next actions and a resume briefing without changing cached data", async () => {
  await json("shipboard_upsert_item", { title: "Investigate preview failure" });
  insertPr(API, 999, "fixture/preview");
  db.prepare("UPDATE prs SET item_id=1, is_draft=1, ci_state='FAILURE', head_sha='fixture-sha'").run();
  const before = db.prepare("SELECT total_changes() AS n").get();
  const actions = await json<{ actions: { kind: string }[]; health: { status: string }[] }>("shipboard_next");
  expect(actions.actions.map((a) => a.kind)).toContain("ci-failing");
  expect(actions.health.every((h) => h.status === "never")).toBe(true);
  const resume = await json<{ item_id: number; stage: string; prs: { head_sha: string }[] }>("shipboard_resume", { item_id: 1 });
  expect(resume.item_id).toBe(1);
  expect(resume.stage).toBe("drafting");
  expect(resume.prs[0]?.head_sha).toBe("fixture-sha");
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect((await call("shipboard_resume", { item_id: 999 })).isError).toBe(true);
  expect((await call("shipboard_next", { limit: 0 })).isError).toBe(true);
});

it("creates an item and reads it back", async () => {
  const created = await json<ItemJson>("shipboard_upsert_item", {
    title: "Dark theme support",
    summary: "Dark theme tokens across API and web.",
    changes: ["adds theme tokens", "wires the picker"],
  });
  expect(created.id).toBe(1);
  expect(created.stage).toBe("drafting");
  expect(created.changes).toEqual(["adds theme tokens", "wires the picker"]);

  const got = await json<ItemJson & { tasks: unknown[]; events: { source: string; text: string }[] }>(
    "shipboard_get",
    { item_id: 1 },
  );
  expect(got.title).toBe("Dark theme support");
  expect(got.events.map((e) => [e.source, e.text])).toEqual([["mcp", 'created item "Dark theme support"']]);

  const sections = await json<{ items: ItemJson[] }>("shipboard_list");
  expect(sections.items.map((i) => i.id)).toEqual([1]);
});

it("edits an item and records what changed", async () => {
  await json("shipboard_upsert_item", { title: "Saved searches" });
  const updated = await json<ItemJson>("shipboard_upsert_item", {
    item_id: 1,
    summary: "Onboarding flow.",
    repo_order: [API, "example/web"],
  });
  expect(updated.summary).toBe("Onboarding flow.");
  expect(updated.repo_order).toEqual([API, "example/web"]);

  const got = await json<{ events: { text: string }[] }>("shipboard_get", { item_id: 1 });
  expect(got.events.at(-1)?.text).toBe("updated summary, repo_order");
});

it("links a PR that is already in the store", async () => {
  insertPr(API, 305, "feature/dark-mode");
  await json("shipboard_upsert_item", { title: "Dark theme support" });

  const linked = await json<ItemJson>("shipboard_link_pr", { item_id: 1, repo: API, number: 305 });
  expect(linked.prs.map((p) => `${p.repo}#${p.number}`)).toEqual([`${API}#305`]);
  expect(linked.stage).toBe("awaiting-review");

  const byBranch = await json<ItemJson>("shipboard_link_pr", {
    item_id: 1,
    repo: API,
    branch: "feature/dark-mode",
  });
  expect(byBranch.prs).toHaveLength(1);
});

it("rejects a link without exactly one of number/branch", async () => {
  insertPr(API, 305, "feature/dark-mode");
  await json("shipboard_upsert_item", { title: "Dark theme support" });

  expect((await call("shipboard_link_pr", { item_id: 1, repo: API })).text).toMatch(/exactly one/);
  const both = await call("shipboard_link_pr", { item_id: 1, repo: API, number: 305, branch: "x" });
  expect(both.isError).toBe(true);
  const unknownRepo = await call("shipboard_link_pr", { item_id: 1, repo: "who/what", number: 1 });
  expect(unknownRepo.isError).toBe(true);
  expect(unknownRepo.text).toMatch(/not a configured repo/);
});

it("sets and clears tracker-owned fields", async () => {
  await json("shipboard_upsert_item", { title: "Saved searches" });

  const blocked = await json<ItemJson>("shipboard_set", {
    item_id: 1,
    stage_override: "needs-testing",
    blocked_reason: "waiting on search index",
    prod_deployed: true,
  });
  // blocked_reason outranks the override in the derived stage.
  expect(blocked.stage).toBe("blocked");
  expect(blocked.stage_override).toBe("needs-testing");
  expect(blocked.prod_deployed_at).not.toBeNull();

  const cleared = await json<ItemJson>("shipboard_set", {
    item_id: 1,
    blocked_reason: null,
    prod_deployed: false,
  });
  expect(cleared.stage).toBe("needs-testing");
  expect(cleared.prod_deployed_at).toBeNull();

  const derived = await json<ItemJson>("shipboard_set", { item_id: 1, stage_override: null });
  expect(derived.stage_override).toBeNull();
  expect(derived.stage).toBe("drafting");

  const bad = await call("shipboard_set", { item_id: 1, stage_override: "nonsense" });
  expect(bad.isError).toBe(true);
  expect(await call("shipboard_set", { item_id: 1 })).toMatchObject({ isError: true });
});

it("adds and completes tasks", async () => {
  await json("shipboard_upsert_item", { title: "Saved searches" });
  const task = await json<{ id: number; kind: string; done_at: string | null }>("shipboard_add_task", {
    item_id: 1,
    kind: "test",
    text: "smoke the onboarding flow on dev",
  });
  expect(task.kind).toBe("test");
  expect(task.done_at).toBeNull();

  const done = await json<{ done_at: string | null }>("shipboard_complete_task", { task_id: task.id });
  expect(done.done_at).not.toBeNull();

  const got = await json<{ tasks: unknown[]; events: { text: string }[] }>("shipboard_get", { item_id: 1 });
  expect(got.tasks).toHaveLength(1);
  expect(got.events.map((e) => e.text)).toContain("task test: smoke the onboarding flow on dev");
  expect(got.events.at(-1)?.text).toBe("done test: smoke the onboarding flow on dev");

  expect((await call("shipboard_add_task", { item_id: 1, kind: "nope", text: "x" })).isError).toBe(true);
  expect((await call("shipboard_complete_task", { task_id: 999 })).isError).toBe(true);
});

it("notes on the timeline", async () => {
  await json("shipboard_upsert_item", { title: "Saved searches" });
  const event = await json<{ item_id: number; source: string; text: string }>("shipboard_note", {
    item_id: 1,
    text: "deployed the API first on purpose",
  });
  expect(event).toMatchObject({ item_id: 1, source: "mcp", text: "deployed the API first on purpose" });
});

it("looks a branch up, hit and miss", async () => {
  insertPr(API, 305, "feature/dark-mode");
  await json("shipboard_upsert_item", { title: "Dark theme support" });
  await json("shipboard_link_pr", { item_id: 1, repo: API, number: 305 });

  const hit = await json<{ pr: { number: number } | null; item: ItemJson | null }>("shipboard_lookup_branch", {
    branch: "feature/dark-mode",
    repo: API,
  });
  expect(hit.pr?.number).toBe(305);
  expect(hit.item?.id).toBe(1);

  const miss = await json<{ pr: null; item: null }>("shipboard_lookup_branch", {
    branch: "feature/nothing",
    repo: API,
  });
  expect(miss).toEqual({ pr: null, item: null });

  const unlinked = await json<{ pr: { number: number } | null; item: ItemJson | null }>(
    "shipboard_lookup_branch",
    { branch: "feature/loose", repo: API },
  );
  expect(unlinked.item).toBeNull();

  expect((await call("shipboard_lookup_branch", { branch: "feature/dark-mode" })).isError).toBe(true);
});

it("reports unknown items as tool errors, not exceptions", async () => {
  for (const [name, args] of [
    ["shipboard_get", { item_id: 42 }],
    ["shipboard_upsert_item", { item_id: 42, title: "x" }],
    ["shipboard_set", { item_id: 42, blocked_reason: "x" }],
    ["shipboard_add_task", { item_id: 42, kind: "test", text: "x" }],
    ["shipboard_note", { item_id: 42, text: "x" }],
    ["shipboard_link_pr", { item_id: 42, repo: API, number: 1 }],
  ] as const) {
    const r = await call(name, args);
    expect(r.isError, `${name} should have errored`).toBe(true);
    expect(r.text).toContain("No item #42");
  }
});

// The link_pr sync fallback (PR missing → syncAll → retry) is deliberately not
// covered: it shells out to `gh`. Everything reachable without the network is.
it("refuses to sync a repo that is not configured", async () => {
  const empty = await start({ ...TEST_CONFIG, projects: [] });
  const bad = await call("shipboard_sync", { repo: API }, empty);
  expect(bad.isError).toBe(true);
  expect(bad.text).toMatch(/not a configured repo. Configured: none/);

  // No repos configured means no gh calls: syncing everything is a no-op.
  expect(await json<unknown[]>("shipboard_sync", {}, empty)).toEqual([]);
});

// ---------- worktrees ----------

it("attaches an item's silo worktrees and reports them in the JSON", async () => {
  insertWorktree({ path: "/w/sample-feature/API", branch: "feature/sample-feature", silo: "sample-feature", unpushed: 2, ahead_of_dev: 2 });
  const created = await json<ItemJson>("shipboard_upsert_item", { title: "Lofti", silo: "sample-feature" });
  expect(created.silo).toBe("sample-feature");
  expect(created.worktrees.map((w) => [w.branch, w.stage, w.pr_number])).toEqual([
    ["feature/sample-feature", "local-only", null],
  ]);
});

it("sets and clears the silo", async () => {
  await json("shipboard_upsert_item", { title: "Lofti" });
  expect((await json<ItemJson>("shipboard_set", { item_id: 1, silo: "sample-feature" })).silo).toBe("sample-feature");
  expect((await json<ItemJson>("shipboard_set", { item_id: 1, silo: null })).silo).toBeNull();

  const got = await json<{ events: { text: string }[] }>("shipboard_get", { item_id: 1 });
  expect(got.events.map((e) => e.text)).toContain("set silo=sample-feature");
  expect(got.events.at(-1)?.text).toBe("set cleared silo");
});

it("lists worktrees, splitting untracked work from housekeeping", async () => {
  // Forgotten: local commits, no PR, no item.
  insertWorktree({ path: "/w/sample-feature/API", branch: "feature/sample-feature", silo: "sample-feature", unpushed: 2, ahead_of_dev: 2 });
  // Nothing ahead of develop any more: safe to remove.
  insertWorktree({ path: "/w/old/API", branch: "feature/old", silo: "old", on_origin: 1 });
  // The main checkout is never listed.
  insertWorktree({ path: "/main/API", branch: "develop", silo: "API", is_main: 1 });

  const all = await json<{ worktrees: WorktreeJson[]; untracked: WorktreeJson[]; housekeeping: WorktreeJson[] }>(
    "shipboard_worktrees",
  );
  expect(all.worktrees.map((w) => w.branch).sort()).toEqual(["feature/old", "feature/sample-feature"]);
  expect(all.untracked.map((w) => w.branch)).toEqual(["feature/sample-feature"]);
  expect(all.housekeeping.map((w) => w.branch)).toEqual(["feature/old"]);

  const one = await json<{ worktrees: WorktreeJson[] }>("shipboard_worktrees", { silo: "sample-feature" });
  expect(one.worktrees.map((w) => w.path)).toEqual(["/w/sample-feature/API"]);

  const elsewhere = await json<{ worktrees: WorktreeJson[] }>("shipboard_worktrees", { project: "other" });
  expect(elsewhere.worktrees).toEqual([]);
});

it("drops a worktree from `untracked` once an item claims its silo", async () => {
  insertWorktree({ path: "/w/sample-feature/API", branch: "feature/sample-feature", silo: "sample-feature", unpushed: 2, ahead_of_dev: 2 });
  expect((await json<{ untracked: WorktreeJson[] }>("shipboard_worktrees")).untracked).toHaveLength(1);

  await json("shipboard_upsert_item", { title: "Lofti", silo: "sample-feature" });
  expect((await json<{ untracked: WorktreeJson[] }>("shipboard_worktrees")).untracked).toEqual([]);
});

it("returns the untracked worktrees in shipboard_list too", async () => {
  insertWorktree({ path: "/w/sample-feature/API", branch: "feature/sample-feature", silo: "sample-feature", unpushed: 2, ahead_of_dev: 2 });
  const sections = await json<{ worktrees: { untracked: WorktreeJson[]; housekeeping: WorktreeJson[] } }>(
    "shipboard_list",
  );
  expect(sections.worktrees.untracked.map((w) => w.stage)).toEqual(["local-only"]);
  expect(sections.worktrees.housekeeping).toEqual([]);
});

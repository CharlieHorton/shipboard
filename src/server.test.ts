import { request, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeWorktree, WorktreeRemovalError } from "./worktree-removal.js";
import { TEST_CONFIG } from "./__fixtures__/config.js";
import { openDb, type Db } from "./db.js";
import { startServer } from "./server.js";
import { captureEvidence } from "./evidence.js";
import * as store from "./store.js";
import type { Config, ItemRow, PrRow } from "./types.js";

const API = "example/API";
const TITLE = "Chinese translations";

// HTTP tests never invoke Git. The removal module has separate fake-Git tests.
vi.mock("./worktree-removal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-removal.js")>();
  return { ...actual, removeWorktree: vi.fn(async () => {}) };
});

let db: Db;
let item: ItemRow;
let base: string;
const servers: Server[] = [];

/** PRs are written by the sync engine; tests insert them by hand. */
function insertPr(p: Partial<PrRow> & { repo: string; number: number }): void {
  db.prepare(
    `INSERT INTO prs (item_id, repo, number, title, author, url, head_branch, base_branch,
                      head_sha, state, is_draft, review_round, unresolved_bot_threads,
                      bot_reviews_on_head, ci_state, synced_at)
     VALUES (@item_id, @repo, @number, @title, @author, @url, @head_branch, @base_branch,
             @head_sha, @state, @is_draft, @review_round, @unresolved_bot_threads,
             @bot_reviews_on_head, @ci_state, @synced_at)`,
  ).run({
    item_id: null,
    title: "PR",
    author: "example",
    url: "",
    head_branch: "feature/chinese",
    base_branch: "develop",
    head_sha: "aaaaaaa",
    state: "OPEN",
    is_draft: 0,
    review_round: 1,
    unresolved_bot_threads: 2,
    bot_reviews_on_head: 1,
    ci_state: "SUCCESS",
    synced_at: "2026-09-03T00:00:00.000Z",
    ...p,
  });
}

async function start(cfg: Config = TEST_CONFIG): Promise<string> {
  const started = await startServer(db, cfg, { port: 0 });
  servers.push(started.server);
  return started.url;
}

async function get(path: string, url = base): Promise<Response> {
  return fetch(`${url}${path}`);
}

async function post(path: string, body?: unknown, url = base): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(async () => {
  vi.mocked(removeWorktree).mockReset().mockResolvedValue(undefined);
  db = openDb(":memory:");
  item = store.createItem(db, { project: "example", title: TITLE });
  insertPr({ repo: API, number: 205, item_id: item.id });
  base = await start();
});

async function removalHeaders(): Promise<Record<string, string>> {
  const html = await (await get("/")).text();
  const token = /id="worktree-token" content="([^"]+)"/.exec(html)?.[1];
  expect(token).toBeTruthy();
  return { "Content-Type": "application/json", "X-Shipboard-Worktree-Token": token! };
}

it("requires the local dashboard token and rejects foreign origins before attempting removal", async () => {
  const body = JSON.stringify({ path: "/synthetic/worktree", expected_head: "a".repeat(40) });
  const headers = await removalHeaders();
  for (const extra of [
    { "X-Shipboard-Worktree-Token": "wrong" },
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Content-Type": "text/plain" },
  ]) {
    const res = await fetch(`${base}/worktrees/remove`, { method: "POST", body, headers: { ...headers, ...extra } });
    expect(res.status, JSON.stringify(extra)).toBe(403);
  }
  // fetch normalizes Host to its URL; use a raw local HTTP request for this case.
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/worktrees/remove`, {
      method: "POST", headers: { ...headers, Host: "foreign.invalid" },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(body);
  });
  expect(hostStatus).toBe(403);
  expect((await post("/worktrees/remove", JSON.parse(body))).status).toBe(403);
  expect(removeWorktree).not.toHaveBeenCalled();
});

it("passes the exact confirmed path and commit to guarded removal", async () => {
  const input = { path: "/synthetic/work tree", expected_head: "a".repeat(40) };
  const res = await fetch(`${base}/worktrees/remove`, { method: "POST", headers: await removalHeaders(), body: JSON.stringify(input) });
  expect(await res.json()).toEqual({ ok: true });
  expect(removeWorktree).toHaveBeenCalledWith(db, TEST_CONFIG, input, undefined);
});

it("rejects missing confirmation fields without attempting removal", async () => {
  const res = await fetch(`${base}/worktrees/remove`, { method: "POST", headers: await removalHeaders(), body: JSON.stringify({ path: "/synthetic/tree" }) });
  expect(res.status).toBe(400);
  expect(removeWorktree).not.toHaveBeenCalled();
});

it("returns a removal refusal and releases the path for retry", async () => {
  vi.mocked(removeWorktree).mockRejectedValueOnce(new WorktreeRemovalError(409, "Local changes need preserving"));
  const options = { method: "POST", headers: await removalHeaders(), body: JSON.stringify({ path: "/synthetic/tree", expected_head: "a".repeat(40) }) };
  const rejected = await fetch(`${base}/worktrees/remove`, options);
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ ok: false, error: "Local changes need preserving" });
  expect((await fetch(`${base}/worktrees/remove`, options)).status).toBe(200);
});

it("prevents concurrent removals of the same worktree", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(removeWorktree).mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const headers = await removalHeaders();
  const body = JSON.stringify({ path: "/synthetic/tree", expected_head: "a".repeat(40) });
  const first = fetch(`${base}/worktrees/remove`, { method: "POST", headers, body });
  await started;
  try {
    expect((await fetch(`${base}/worktrees/remove`, { method: "POST", headers, body })).status).toBe(409);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    expect((await first).status).toBe(200);
  }
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  db.close();
});

it("serves the dashboard as HTML with no caching", async () => {
  const res = await get("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

it("accepts a project filter, including an unknown one", async () => {
  expect((await get("/?project=example")).status).toBe(200);
  expect((await get("/?project=nope")).status).toBe(200);
  const board = await json<{ items: unknown[] }>(await get("/api/board?project=nope"));
  expect(board.items).toEqual([]);
});

it("serves the item drawer, and 404/400 for bad ids", async () => {
  const res = await get(`/item/${item.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");

  const missing = await get("/item/999");
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe("No item #999");

  expect((await get("/item/abc")).status).toBe(400);
});

it("returns the board as JSON", async () => {
  const board = await json<{ items: { id: number; title: string; stage: string; prs: unknown[] }[] }>(
    await get("/api/board"),
  );
  expect(board.items).toHaveLength(1);
  expect(board.items[0]?.title).toBe(TITLE);
  expect(board.items[0]?.stage).toBe("needs-addressing");
  expect(board.items[0]?.prs).toHaveLength(1);
});

it("returns one item with its stage, tasks and events", async () => {
  store.addTask(db, item.id, "test", "smoke on dev");
  const view = await json<{ stage: string; tasks: unknown[]; events: unknown[] }>(
    await get(`/api/items/${item.id}`),
  );
  expect(view.stage).toBe("needs-addressing");
  expect(view.tasks).toHaveLength(1);
  expect(view.events).toEqual([]);

  const missing = await get("/api/items/999");
  expect(missing.status).toBe(404);
  expect(await json<{ ok: boolean }>(missing)).toEqual({ ok: false, error: "No item #999" });
});

it("serves read-only next actions and source health with project isolation", async () => {
  db.prepare("UPDATE prs SET is_draft=1, ci_state='FAILURE'").run();
  const before = db.prepare("SELECT total_changes() AS n").get();
  const next = await json<{ actions: { kind: string }[]; health: { status: string }[] }>(await get("/api/next"));
  expect(next.actions.map((a) => a.kind)).toContain("ci-failing");
  expect(next.health.every((h) => h.status === "never")).toBe(true);
  expect(await json(await get("/api/next?project=missing"))).toEqual({ actions: [], health: [] });
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("serves a cached resume briefing as JSON and downloadable text", async () => {
  store.addEvent(db, item.id, "user", "Resume with the preview logs");
  const before = db.prepare("SELECT total_changes() AS n").get();
  const brief = await json<{ item_id: number; recent_events: { text: string }[] }>(await get(`/api/items/${item.id}/resume`));
  expect(brief.item_id).toBe(item.id);
  expect(brief.recent_events[0]?.text).toBe("Resume with the preview logs");
  const text = await get(`/api/items/${item.id}/resume?format=text`);
  expect(text.headers.get("content-type")).toContain("text/plain");
  expect(await text.text()).toContain("Resume with the preview logs");
  expect((await get("/api/items/no/resume")).status).toBe(400);
  expect((await get("/api/items/999/resume")).status).toBe(404);
  expect((await post(`/api/items/${item.id}/resume`)).status).toBe(405);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("completes a task and records an event", async () => {
  const task = store.addTask(db, item.id, "test", "smoke on dev");
  const res = await post(`/tasks/${task.id}/done`, { expected_evidence: captureEvidence(store.prsForItem(db, item.id)) });
  expect(res.status).toBe(200);
  const body = await json<{ ok: boolean; task: { done_at: string | null } }>(res);
  expect(body.ok).toBe(true);
  expect(body.task.done_at).not.toBeNull();

  const events = store.eventsForItem(db, item.id);
  expect(events.map((e) => e.text)).toContain("done test: smoke on dev");

  expect((await post("/tasks/999/done")).status).toBe(404);
});

it("archives an item out of the board", async () => {
  expect(await json<{ ok: boolean }>(await post(`/items/${item.id}/archive`))).toEqual({ ok: true });
  const board = await json<{ items: unknown[] }>(await get("/api/board"));
  expect(board.items).toEqual([]);
  expect(store.getItem(db, item.id)?.archived_at).not.toBeNull();
  expect(store.eventsForItem(db, item.id).map((e) => e.text)).toContain("archived");

  expect((await post("/items/999/archive")).status).toBe(404);
});

it("asserts a prod deploy", async () => {
  expect(await json<{ ok: boolean }>(await post(`/items/${item.id}/deployed`, { expected_evidence: captureEvidence(store.prsForItem(db, item.id)) }))).toEqual({ ok: true });
  expect(store.getItem(db, item.id)?.prod_deployed_at).not.toBeNull();
  expect(store.eventsForItem(db, item.id).map((e) => e.text)).toContain("deployed to prod");
});

it("rejects test/deploy confirmations for commits changed since the drawer was opened", async () => {
  const task = store.addTask(db, item.id, "test", "verify fixture");
  const expected_evidence = captureEvidence(store.prsForItem(db, item.id));
  db.prepare("UPDATE prs SET head_sha='new-fixture-commit'").run();
  expect((await post(`/tasks/${task.id}/done`, { expected_evidence })).status).toBe(409);
  expect((await post(`/items/${item.id}/deployed`, { expected_evidence })).status).toBe(409);
  expect(store.getTask(db, task.id)?.done_at).toBeNull();
  expect(store.getItem(db, item.id)?.prod_deployed_at).toBeNull();
  expect(store.eventsForItem(db, item.id)).toEqual([]);
  expect((await post(`/tasks/${task.id}/done`)).status).toBe(409);
  const current = captureEvidence(store.prsForItem(db, item.id));
  expect((await post(`/tasks/${task.id}/done`, { expected_evidence: current })).status).toBe(200);
  expect((await post(`/items/${item.id}/deployed`, { expected_evidence: current })).status).toBe(200);
});

it("syncs with no configured repos without touching the network", async () => {
  const url = await start({ ...TEST_CONFIG, projects: [] });
  const body = await json<{ ok: boolean; results: unknown[] }>(await post("/sync", undefined, url));
  expect(body).toEqual({ ok: true, results: [] });
});

it("405s a known path with the wrong method and 404s an unknown one", async () => {
  expect((await get("/sync")).status).toBe(405);
  expect((await post("/")).status).toBe(405);
  expect((await get("/nope")).status).toBe(404);
  expect((await get(`/api/items/${item.id}/nope`)).status).toBe(404);
});

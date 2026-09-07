import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";
import {
  addEvent,
  addTask,
  completeTask,
  createItem,
  eventsForItem,
  findPr,
  findPrByBranch,
  getItem,
  getPr,
  linkPr,
  listItems,
  listPrs,
  parseJsonArray,
  prsForItem,
  tasksForItem,
  unlinkPr,
  updateItem,
} from "./store.js";
import type { PrRow } from "./types.js";

const API = "example/API";
const WEB = "example/web";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

/** PRs are written by the sync engine; tests insert them by hand. */
function insertPr(p: Partial<PrRow> & { repo: string; number: number }): PrRow {
  const row = {
    title: "PR",
    author: "example",
    url: "",
    head_branch: "feature/x",
    base_branch: "develop",
    head_sha: "aaaaaaa",
    state: "OPEN",
    is_draft: 0,
    review_round: 1,
    unresolved_bot_threads: 0,
    bot_reviews_on_head: 1,
    ci_state: "SUCCESS",
    synced_at: "2026-09-03T00:00:00.000Z",
    ...p,
  };
  db.prepare(
    `INSERT INTO prs (repo, number, title, author, url, head_branch, base_branch, head_sha,
                      state, is_draft, review_round, unresolved_bot_threads, bot_reviews_on_head,
                      ci_state, synced_at)
     VALUES (@repo, @number, @title, @author, @url, @head_branch, @base_branch, @head_sha,
             @state, @is_draft, @review_round, @unresolved_bot_threads, @bot_reviews_on_head,
             @ci_state, @synced_at)`,
  ).run(row);
  const inserted = findPr(db, p.repo, p.number);
  if (!inserted) throw new Error("insert failed");
  return inserted;
}

describe("parseJsonArray", () => {
  it("returns strings, and nothing at all for junk", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
    expect(parseJsonArray("not json")).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray('["a", 1, "b"]')).toEqual(["a", "b"]);
  });
});

describe("items", () => {
  it("creates with json columns round-tripping", () => {
    const item = createItem(db, {
      project: "example",
      title: "Stripe Connect agents",
      summary: "Let agents onboard to Connect",
      changes: ["adds /connect", "flag stripe_connect"],
      linear_key: "PS-101",
      repo_order: [API, WEB],
    });
    expect(item.id).toBe(1);
    expect(parseJsonArray(item.changes)).toEqual(["adds /connect", "flag stripe_connect"]);
    expect(parseJsonArray(item.repo_order)).toEqual([API, WEB]);
    expect(getItem(db, item.id)).toEqual(item);
  });

  it("leaves optional columns null", () => {
    const item = createItem(db, { project: "example", title: "Bare" });
    expect(item.summary).toBeNull();
    expect(item.changes).toBeNull();
    expect(item.repo_order).toBeNull();
    expect(item.archived_at).toBeNull();
  });

  it("updateItem patches, bumps updated_at and leaves other columns alone", () => {
    const item = createItem(db, { project: "example", title: "Old", summary: "keep me" });
    db.prepare(`UPDATE items SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(item.id);
    const before = getItem(db, item.id)!;

    const after = updateItem(db, item.id, { title: "New", blocked_reason: "waiting on Stripe" });
    expect(after.title).toBe("New");
    expect(after.blocked_reason).toBe("waiting on Stripe");
    expect(after.summary).toBe("keep me");
    expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
    expect(after.created_at).toBe(before.created_at);
  });

  it("updateItem can clear a column", () => {
    const item = createItem(db, { project: "example", title: "T" });
    updateItem(db, item.id, { stage_override: "tested" });
    expect(getItem(db, item.id)!.stage_override).toBe("tested");
    expect(updateItem(db, item.id, { stage_override: null }).stage_override).toBeNull();
  });

  it("updateItem throws for a missing item", () => {
    expect(() => updateItem(db, 99, { title: "x" })).toThrow("item 99 not found");
  });

  it("lists by project and hides archived items by default", () => {
    const a = createItem(db, { project: "example", title: "A" });
    createItem(db, { project: "other", title: "B" });
    const c = createItem(db, { project: "example", title: "C" });
    updateItem(db, c.id, { archived_at: "2026-09-03T00:00:00.000Z" });

    expect(listItems(db).map((i) => i.title)).toEqual(["A", "B"]);
    expect(listItems(db, { project: "example" }).map((i) => i.title)).toEqual(["A"]);
    expect(listItems(db, { includeArchived: true }).map((i) => i.title)).toEqual(["A", "B", "C"]);
    expect(listItems(db, { project: "example", includeArchived: true }).map((i) => i.id)).toEqual([
      a.id,
      c.id,
    ]);
  });
});

describe("prs", () => {
  it("finds by repo and number", () => {
    insertPr({ repo: API, number: 205 });
    expect(findPr(db, API, 205)?.number).toBe(205);
    expect(findPr(db, API, 999)).toBeUndefined();
    expect(findPr(db, WEB, 205)).toBeUndefined();
  });

  it("findPrByBranch prefers the open PR", () => {
    insertPr({ repo: API, number: 100, head_branch: "feature/chinese", state: "MERGED" });
    insertPr({ repo: API, number: 237, head_branch: "feature/chinese", state: "OPEN" });
    expect(findPrByBranch(db, API, "feature/chinese")?.number).toBe(237);
  });

  it("findPrByBranch falls back to the most recently synced", () => {
    insertPr({
      repo: API,
      number: 100,
      head_branch: "feature/chinese",
      state: "MERGED",
      synced_at: "2026-09-01T00:00:00.000Z",
    });
    insertPr({
      repo: API,
      number: 120,
      head_branch: "feature/chinese",
      state: "CLOSED",
      synced_at: "2026-09-02T00:00:00.000Z",
    });
    expect(findPrByBranch(db, API, "feature/chinese")?.number).toBe(120);
    expect(findPrByBranch(db, API, "feature/nope")).toBeUndefined();
  });

  it("filters by repo, state and link status", () => {
    const item = createItem(db, { project: "example", title: "T" });
    const linked = insertPr({ repo: API, number: 205 });
    insertPr({ repo: API, number: 300, state: "MERGED" });
    insertPr({ repo: WEB, number: 284 });
    linkPr(db, item.id, linked.id);

    expect(listPrs(db, { repo: API }).map((p) => p.number)).toEqual([205, 300]);
    expect(listPrs(db, { state: "OPEN" }).map((p) => p.number)).toEqual([205, 284]);
    expect(listPrs(db, { unlinkedOnly: true }).map((p) => p.number)).toEqual([300, 284]);
    expect(listPrs(db, { repo: API, state: "OPEN", unlinkedOnly: true })).toEqual([]);
  });

  it("linkPr attaches the PR and records a user event", () => {
    const item = createItem(db, { project: "example", title: "T" });
    const pr = insertPr({ repo: API, number: 205 });

    linkPr(db, item.id, pr.id);
    expect(getPr(db, pr.id)?.item_id).toBe(item.id);
    expect(prsForItem(db, item.id).map((p) => p.number)).toEqual([205]);

    const events = eventsForItem(db, item.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("user");
    expect(events[0]!.text).toBe(`linked PR ${API}#205`);
  });

  it("unlinkPr detaches and records the event against the old item", () => {
    const item = createItem(db, { project: "example", title: "T" });
    const pr = insertPr({ repo: API, number: 205 });
    linkPr(db, item.id, pr.id);

    unlinkPr(db, pr.id);
    expect(getPr(db, pr.id)?.item_id).toBeNull();
    expect(prsForItem(db, item.id)).toEqual([]);
    expect(eventsForItem(db, item.id).map((e) => e.text)).toEqual([
      `linked PR ${API}#205`,
      `unlinked PR ${API}#205`,
    ]);
  });

  it("linkPr refuses unknown rows", () => {
    const item = createItem(db, { project: "example", title: "T" });
    expect(() => linkPr(db, item.id, 42)).toThrow("pr 42 not found");
    const pr = insertPr({ repo: API, number: 205 });
    expect(() => linkPr(db, 99, pr.id)).toThrow("item 99 not found");
  });
});

describe("tasks", () => {
  it("adds, lists and completes", () => {
    const item = createItem(db, { project: "example", title: "T" });
    const testTask = addTask(db, item.id, "test", "smoke on dev");
    const flag = addTask(db, item.id, "flag", "flip stripe_connect");

    expect(tasksForItem(db, item.id).map((t) => t.kind)).toEqual(["test", "flag"]);
    expect(testTask.done_at).toBeNull();

    const done = completeTask(db, testTask.id);
    expect(done.done_at).not.toBeNull();
    expect(tasksForItem(db, item.id).filter((t) => t.done_at == null).map((t) => t.id)).toEqual([
      flag.id,
    ]);
    expect(() => completeTask(db, 99)).toThrow("task 99 not found");
  });
});

describe("events", () => {
  it("keeps the most recent N in chronological order", () => {
    const item = createItem(db, { project: "example", title: "T" });
    for (let i = 1; i <= 5; i++) addEvent(db, item.id, "sync", `event ${i}`);

    expect(eventsForItem(db, item.id).map((e) => e.text)).toEqual([
      "event 1",
      "event 2",
      "event 3",
      "event 4",
      "event 5",
    ]);
    expect(eventsForItem(db, item.id, 2).map((e) => e.text)).toEqual(["event 4", "event 5"]);
  });
});

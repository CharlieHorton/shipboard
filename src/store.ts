/**
 * Thin typed SQL over the SQLite store. Every function is synchronous and takes
 * the open database first. No stage logic lives here.
 */
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import { captureEvidence } from "./evidence.js";
import type {
  EventRow,
  EventSource,
  ItemRow,
  ItemStage,
  PrRow,
  PrState,
  RepoKey,
  TaskKind,
  TaskRow,
  WorktreeRow,
} from "./types.js";

/** Parse a JSON array column ("changes", "repo_order"); tolerant of junk. */
export function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

function toJson(v: readonly string[] | undefined): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

// ---------- items ----------

export interface NewItem {
  project: string;
  title: string;
  summary?: string;
  changes?: string[];
  linear_key?: string;
  silo?: string;
  repo_order?: string[];
}

export function createItem(db: Db, input: NewItem): ItemRow {
  const info = db
    .prepare(
      `INSERT INTO items (project, title, summary, changes, linear_key, silo, repo_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project,
      input.title,
      input.summary ?? null,
      toJson(input.changes),
      input.linear_key ?? null,
      input.silo ?? null,
      toJson(input.repo_order),
    );
  return mustGetItem(db, Number(info.lastInsertRowid));
}

const ITEM_PATCH_COLUMNS = [
  "title",
  "summary",
  "changes",
  "linear_key",
  "silo",
  "repo_order",
  "stage_override",
  "blocked_reason",
  "prod_deployed_at",
  "archived_at",
] as const;

export type ItemPatch = Partial<Pick<ItemRow, (typeof ITEM_PATCH_COLUMNS)[number]>>;

/** Apply a patch and bump `updated_at`. Throws if the item does not exist. */
export function updateItem(db: Db, id: number, patch: ItemPatch): ItemRow {
  if (!getItem(db, id)) throw new Error(`item ${id} not found`);
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const col of ITEM_PATCH_COLUMNS) {
    if (!(col in patch)) continue;
    sets.push(`${col} = ?`);
    values.push((patch[col] as string | ItemStage | null | undefined) ?? null);
  }
  if ("prod_deployed_at" in patch) {
    sets.push("prod_deploy_evidence = ?");
    values.push(patch.prod_deployed_at ? captureEvidence(prsForItem(db, id)) : null);
  }
  sets.push("updated_at = ?");
  values.push(nowIso());
  db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return mustGetItem(db, id);
}

export function findItemBySilo(db: Db, silo: string): ItemRow | undefined {
  return db
    .prepare(`SELECT * FROM items WHERE silo = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(silo) as ItemRow | undefined;
}

export function getItem(db: Db, id: number): ItemRow | undefined {
  return db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
}

function mustGetItem(db: Db, id: number): ItemRow {
  const row = getItem(db, id);
  if (!row) throw new Error(`item ${id} not found`);
  return row;
}

export function listItems(
  db: Db,
  opts: { project?: string; includeArchived?: boolean } = {},
): ItemRow[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.project !== undefined) {
    where.push(`project = ?`);
    values.push(opts.project);
  }
  if (!opts.includeArchived) where.push(`archived_at IS NULL`);
  const sql = `SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
  return db.prepare(sql).all(...values) as ItemRow[];
}

// ---------- prs ----------

export function prsForItem(db: Db, itemId: number): PrRow[] {
  return db
    .prepare(`SELECT * FROM prs WHERE item_id = ? ORDER BY repo, number`)
    .all(itemId) as PrRow[];
}

export function listPrs(
  db: Db,
  opts: { repo?: RepoKey; state?: PrState; unlinkedOnly?: boolean } = {},
): PrRow[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.repo !== undefined) {
    where.push(`repo = ?`);
    values.push(opts.repo);
  }
  if (opts.state !== undefined) {
    where.push(`state = ?`);
    values.push(opts.state);
  }
  if (opts.unlinkedOnly) where.push(`item_id IS NULL`);
  const sql = `SELECT * FROM prs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY repo, number`;
  return db.prepare(sql).all(...values) as PrRow[];
}

export function getPr(db: Db, id: number): PrRow | undefined {
  return db.prepare(`SELECT * FROM prs WHERE id = ?`).get(id) as PrRow | undefined;
}

export function findPr(db: Db, repo: RepoKey, number: number): PrRow | undefined {
  return db.prepare(`SELECT * FROM prs WHERE repo = ? AND number = ?`).get(repo, number) as
    | PrRow
    | undefined;
}

/** Most relevant PR for a branch: open ones first, then most recently synced. */
export function findPrByBranch(db: Db, repo: RepoKey, branch: string): PrRow | undefined {
  return db
    .prepare(
      `SELECT * FROM prs WHERE repo = ? AND head_branch = ?
       ORDER BY (state = 'OPEN') DESC, synced_at DESC, number DESC LIMIT 1`,
    )
    .get(repo, branch) as PrRow | undefined;
}

export function linkPr(db: Db, itemId: number, prId: number): void {
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);
  mustGetItem(db, itemId);
  db.prepare(`UPDATE prs SET item_id = ? WHERE id = ?`).run(itemId, prId);
  addEvent(db, itemId, "user", `linked PR ${pr.repo}#${pr.number}`);
}

export function unlinkPr(db: Db, prId: number): void {
  const pr = getPr(db, prId);
  if (!pr) throw new Error(`pr ${prId} not found`);
  db.prepare(`UPDATE prs SET item_id = NULL WHERE id = ?`).run(prId);
  if (pr.item_id != null) {
    addEvent(db, pr.item_id, "user", `unlinked PR ${pr.repo}#${pr.number}`);
  }
}

// ---------- worktrees (derived by sync; read-only here) ----------

export function listWorktrees(db: Db, opts: { repo?: RepoKey; silo?: string } = {}): WorktreeRow[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.repo !== undefined) {
    where.push(`repo = ?`);
    values.push(opts.repo);
  }
  if (opts.silo !== undefined) {
    where.push(`silo = ?`);
    values.push(opts.silo);
  }
  const sql = `SELECT * FROM worktrees ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY repo, path`;
  return db.prepare(sql).all(...values) as WorktreeRow[];
}

export function findWorktree(db: Db, repo: RepoKey, branch: string): WorktreeRow | undefined {
  return db
    .prepare(`SELECT * FROM worktrees WHERE repo = ? AND branch = ? ORDER BY is_main, path LIMIT 1`)
    .get(repo, branch) as WorktreeRow | undefined;
}

// ---------- tasks ----------

export function addTask(db: Db, itemId: number, kind: TaskKind, text: string): TaskRow {
  mustGetItem(db, itemId);
  const info = db
    .prepare(`INSERT INTO tasks (item_id, kind, text) VALUES (?, ?, ?)`)
    .run(itemId, kind, text);
  return mustGetTask(db, Number(info.lastInsertRowid));
}

export function completeTask(db: Db, taskId: number): TaskRow {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const evidence = task.kind === "test" ? captureEvidence(prsForItem(db, task.item_id)) : null;
  db.prepare(`UPDATE tasks SET done_at = ?, completion_evidence = ? WHERE id = ?`)
    .run(nowIso(), evidence, taskId);
  return mustGetTask(db, taskId);
}

export function getTask(db: Db, taskId: number): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
}

function mustGetTask(db: Db, taskId: number): TaskRow {
  const row = getTask(db, taskId);
  if (!row) throw new Error(`task ${taskId} not found`);
  return row;
}

export function tasksForItem(db: Db, itemId: number): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE item_id = ? ORDER BY id`).all(itemId) as TaskRow[];
}

// ---------- events ----------

export function addEvent(db: Db, itemId: number, source: EventSource, text: string): EventRow {
  const info = db
    .prepare(`INSERT INTO events (item_id, at, source, text) VALUES (?, ?, ?, ?)`)
    .run(itemId, nowIso(), source, text);
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(Number(info.lastInsertRowid)) as
    | EventRow
    | undefined;
  if (!row) throw new Error(`event insert failed for item ${itemId}`);
  return row;
}

/** Oldest first. `limit` keeps the most recent N, still in chronological order. */
export function eventsForItem(db: Db, itemId: number, limit?: number): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM events WHERE item_id = ? ORDER BY at DESC, id DESC LIMIT ?
       ) ORDER BY at ASC, id ASC`,
    )
    .all(itemId, limit ?? -1) as EventRow[];
}

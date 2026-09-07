import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { shipboardHome } from "./config.js";

export type Db = Database.Database;

/** Default DB path. Override with SHIPBOARD_DB (":memory:" allowed). */
export function defaultDbPath(): string {
  return process.env["SHIPBOARD_DB"] ?? join(shipboardHome(), "shipboard.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project          TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT,
  changes          TEXT,            -- JSON array of strings
  linear_key       TEXT,
  repo_order       TEXT,            -- JSON array of "owner/name"
  stage_override   TEXT,
  blocked_reason   TEXT,
  prod_deployed_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at      TEXT
);

CREATE TABLE IF NOT EXISTS prs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id                INTEGER REFERENCES items(id) ON DELETE SET NULL,
  repo                   TEXT NOT NULL,   -- "owner/name"
  number                 INTEGER NOT NULL,
  title                  TEXT NOT NULL DEFAULT '',
  author                 TEXT NOT NULL DEFAULT '',
  url                    TEXT NOT NULL DEFAULT '',
  head_branch            TEXT NOT NULL DEFAULT '',
  base_branch            TEXT NOT NULL DEFAULT '',
  head_sha               TEXT NOT NULL DEFAULT '',
  state                  TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | MERGED | CLOSED
  is_draft               INTEGER NOT NULL DEFAULT 0,
  review_round           INTEGER NOT NULL DEFAULT 0,
  unresolved_bot_threads INTEGER NOT NULL DEFAULT 0,
  bot_reviews_on_head    INTEGER NOT NULL DEFAULT 0,
  ci_state               TEXT,
  merged_at              TEXT,
  merge_sha              TEXT,
  in_release_pr          INTEGER,
  on_dev                 INTEGER NOT NULL DEFAULT 0,
  on_prod                INTEGER NOT NULL DEFAULT 0,
  synced_at              TEXT NOT NULL DEFAULT '',
  UNIQUE (repo, number)
);
CREATE INDEX IF NOT EXISTS prs_item_id ON prs(item_id);
CREATE INDEX IF NOT EXISTS prs_repo_branch ON prs(repo, head_branch);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,   -- test|flag|env|migration|changelog|helpbot|other
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS tasks_item_id ON tasks(item_id);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source  TEXT NOT NULL,   -- hook|mcp|sync|user
  text    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_item_id ON events(item_id, at);

CREATE TABLE IF NOT EXISTS ota_updates (
  group_id   TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,   -- "owner/name"
  branch     TEXT NOT NULL,   -- EAS branch
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  platforms  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ota_updates_repo_branch ON ota_updates(repo, branch, created_at);

CREATE TABLE IF NOT EXISTS worktrees (
  path           TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  branch         TEXT NOT NULL,
  head_sha       TEXT NOT NULL DEFAULT '',
  silo           TEXT NOT NULL DEFAULT '',
  is_main        INTEGER NOT NULL DEFAULT 0,
  ahead_of_dev   INTEGER NOT NULL DEFAULT 0,
  unpushed       INTEGER NOT NULL DEFAULT 0,
  on_origin      INTEGER NOT NULL DEFAULT 0,
  dirty          INTEGER NOT NULL DEFAULT 0,
  last_commit_at TEXT NOT NULL DEFAULT '',
  seen_at        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS worktrees_repo_branch ON worktrees(repo, branch);
CREATE INDEX IF NOT EXISTS worktrees_silo ON worktrees(silo);

CREATE TABLE IF NOT EXISTS sync_health (
  repo            TEXT NOT NULL,
  source          TEXT NOT NULL CHECK(source IN ('github','eas','worktrees')),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  errors          TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (repo, source)
);
`;

/** Columns added after the first release; applied idempotently on open. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "prs", column: "deployed_at", ddl: "ALTER TABLE prs ADD COLUMN deployed_at TEXT" },
  { table: "prs", column: "deploy_ref", ddl: "ALTER TABLE prs ADD COLUMN deploy_ref TEXT" },
  { table: "items", column: "silo", ddl: "ALTER TABLE items ADD COLUMN silo TEXT" },
  { table: "items", column: "prod_deploy_evidence", ddl: "ALTER TABLE items ADD COLUMN prod_deploy_evidence TEXT" },
  { table: "tasks", column: "completion_evidence", ddl: "ALTER TABLE tasks ADD COLUMN completion_evidence TEXT" },
];

function migrate(db: Db): void {
  for (const m of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
}

/** Open (creating if needed) the SQLite store with schema applied. */
export function openDb(path: string = defaultDbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

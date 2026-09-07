import { allRepos } from "./config.js";
import { nowIso, type Db } from "./db.js";
import { repoKey, type Config } from "./types.js";

export type SyncSource = "github" | "eas" | "worktrees";

export interface SyncHealthView {
  repo: string;
  source: SyncSource;
  last_attempt_at: string | null;
  last_success_at: string | null;
  errors: string[];
  status: "never" | "failed" | "stale" | "healthy";
}

export function beginSync(db: Db, repo: string, source: SyncSource, at = nowIso()): void {
  db.prepare(`INSERT INTO sync_health (repo, source, last_attempt_at) VALUES (?, ?, ?)
    ON CONFLICT(repo, source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`).run(repo, source, at);
}

export function finishSync(db: Db, repo: string, source: SyncSource, errors: string[], at = nowIso()): void {
  db.prepare(`UPDATE sync_health SET errors = ?,
    last_success_at = CASE WHEN ? = 0 THEN ? ELSE last_success_at END
    WHERE repo = ? AND source = ?`).run(JSON.stringify(errors), errors.length, at, repo, source);
}

/** Include configured sources with no attempts, so missing data cannot look healthy. */
export function readSyncHealth(
  db: Db,
  cfg: Config,
  opts: { project?: string; staleAfterMs?: number; now?: string } = {},
): SyncHealthView[] {
  const repos = opts.project === undefined
    ? allRepos(cfg)
    : cfg.projects.filter((p) => p.name === opts.project).flatMap((p) => p.repos);
  const now = Date.parse(opts.now ?? nowIso());
  const staleAfterMs = opts.staleAfterMs ?? 30 * 60 * 1000;
  const read = db.prepare(`SELECT last_attempt_at, last_success_at, errors FROM sync_health WHERE repo = ? AND source = ?`);
  return repos.flatMap((repo) => {
    const sources: SyncSource[] = ["github"];
    if (repo.eas) sources.push("eas");
    if (repo.local !== undefined) sources.push("worktrees");
    return sources.map((source): SyncHealthView => {
      const row = read.get(repoKey(repo), source) as
        { last_attempt_at: string; last_success_at: string | null; errors: string } | undefined;
      const errors = row ? JSON.parse(row.errors) as string[] : [];
      const lastSuccess = row?.last_success_at ?? null;
      const status = !row ? "never" : errors.length > 0 ? "failed"
        : lastSuccess === null || !Number.isFinite(Date.parse(lastSuccess)) || now - Date.parse(lastSuccess) > staleAfterMs
          ? "stale" : "healthy";
      return { repo: repoKey(repo), source, last_attempt_at: row?.last_attempt_at ?? null,
        last_success_at: lastSuccess, errors, status };
    });
  });
}

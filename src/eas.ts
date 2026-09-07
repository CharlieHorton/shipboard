/**
 * Expo EAS Update access for Shipboard.
 *
 * GitHub cannot see an OTA deploy, so the tracker asks the `eas` CLI instead:
 * `eas update:list` names the update groups published on a branch, and
 * `eas update:view <group>` is the only place the git commit behind a group
 * appears. Both calls are slow (2-8 s) and hit the network, so every group is
 * cached in `ota_updates` and `update:view` only ever runs for a group the
 * table has not seen.
 *
 * Nothing here throws: a missing CLI, an expired login or an unparseable
 * response degrades to "no OTA information", never to a failed sync.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import type { OtaUpdateRow, RepoConfig, RepoKey } from "./types.js";
import { repoKey } from "./types.js";

const execFileAsync = promisify(execFile);

/** eas prints one row per platform; a busy branch listing is still small. */
const MAX_BUFFER = 8 * 1024 * 1024;

/** How many groups `syncOtaUpdates` asks for. Newest first. */
export const LIST_LIMIT = 20;

/** Override for an EAS CLI installation outside PATH. */
function easBin(): string {
  return process.env["SHIPBOARD_EAS_BIN"] ?? "eas";
}

export class EasError extends Error {
  readonly args: string[];
  constructor(args: string[], detail: string) {
    super(`eas ${args.slice(0, 2).join(" ")}: ${detail}`);
    this.name = "EasError";
    this.args = args;
  }
}

// ---------- wire shapes (only what we read) ----------

/** One row of `eas update:list --json`.currentPage. */
export interface EasGroup {
  group: string;
  branch: string;
  message: string;
  /** "android", "ios" or "android, ios". */
  platforms: string;
  isRollBackToEmbedded: boolean;
}

/** The parts of `eas update:view --json` that identify a deploy. */
export interface EasGroupDetail {
  commitSha: string;
  createdAt: string;
  platforms: string;
  message: string;
}

/**
 * Everything sync needs from EAS. `easClient` is the real implementation;
 * tests inject a fake so no test spawns a process or touches the network.
 */
export interface EasClient {
  listGroups(cwd: string, branch: string, limit: number): Promise<EasGroup[]>;
  /** `undefined` when the group has no git commit behind it (rollback, legacy publish). */
  viewGroup(cwd: string, group: string): Promise<EasGroupDetail | undefined>;
}

// ---------- parsing ----------

/**
 * Parse `eas … --json` stdout, tolerating the upgrade/telemetry banner the CLI
 * sometimes prints ahead of the payload: slice from the first `{` or `[`.
 */
export function parseEasJson(stdout: string): unknown {
  const brace = stdout.indexOf("{");
  const bracket = stdout.indexOf("[");
  const start =
    brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
  if (start === -1) throw new Error(`no JSON in eas output: ${stdout.trim().slice(0, 200)}`);
  return JSON.parse(stdout.slice(start)) as unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null) : [];
}

/** "android" + "ios" → "android, ios", preserving eas's own ordering. */
function joinPlatforms(values: string[]): string {
  return [...new Set(values.filter((p) => p !== ""))].join(", ");
}

async function runEas(cwd: string, args: string[]): Promise<string> {
  try {
    // The banner goes to stderr; stdout is the payload.
    const { stdout } = await execFileAsync(easBin(), args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr : "";
    const line = (stderr.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    throw new EasError(args, line || (err instanceof Error ? err.message : String(err)));
  }
}

export const easClient: EasClient = {
  async listGroups(cwd, branch, limit) {
    const stdout = await runEas(cwd, [
      "update:list",
      "--branch",
      branch,
      "--json",
      "--non-interactive",
      "--limit",
      String(limit),
    ]);
    const page = (parseEasJson(stdout) as { currentPage?: unknown }).currentPage;
    return rows(page).flatMap((r) => {
      const group = str(r["group"]);
      if (group === "") return [];
      return [
        {
          group,
          branch: str(r["branch"]),
          message: str(r["message"]),
          platforms: str(r["platforms"]),
          isRollBackToEmbedded: r["isRollBackToEmbedded"] === true,
        },
      ];
    });
  },

  async viewGroup(cwd, group) {
    // NB: update:view has no --non-interactive flag; passing one makes it exit 1.
    const stdout = await runEas(cwd, ["update:view", group, "--json"]);
    const updates = rows(parseEasJson(stdout));
    const first = updates[0];
    if (first === undefined) return undefined;
    const commitSha = str(first["gitCommitHash"]);
    if (commitSha === "" || first["isRollBackToEmbedded"] === true) return undefined;
    return {
      commitSha,
      createdAt: str(first["createdAt"]),
      platforms: joinPlatforms(updates.map((u) => str(u["platform"]))),
      message: str(first["message"]),
    };
  },
};

// ---------- store ----------

/** `~/x` → `$HOME/x`; config files are hand-edited and often use a tilde. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

const INSERT_OTA = `
INSERT OR IGNORE INTO ota_updates (group_id, repo, branch, commit_sha, created_at, message, platforms)
VALUES (?, ?, ?, ?, ?, ?, ?)`;

export interface OtaSyncResult {
  /** Groups the branch listing returned. */
  seen: number;
  /** Groups newly cached in `ota_updates`. */
  added: number;
  errors: string[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Refresh the `ota_updates` cache for one repo's configured EAS branch.
 *
 * Lists the newest `LIST_LIMIT` groups and calls `update:view` only for the
 * ones not already cached, so a steady-state sync costs exactly one eas call.
 * Never throws; failures land in `errors`.
 */
export async function syncOtaUpdates(
  db: Db,
  repo: RepoConfig,
  client: EasClient = easClient,
): Promise<OtaSyncResult> {
  const out: OtaSyncResult = { seen: 0, added: 0, errors: [] };
  const eas = repo.eas;
  if (eas === undefined) return out;

  const key = repoKey(repo);
  const cwd = expandHome(eas.cwd);

  let groups: EasGroup[];
  try {
    groups = await client.listGroups(cwd, eas.branch, LIST_LIMIT);
  } catch (err) {
    out.errors.push(`update:list ${eas.branch}: ${errText(err)}`);
    return out;
  }
  out.seen = groups.length;

  const known = new Set(
    (db.prepare(`SELECT group_id FROM ota_updates WHERE repo = ?`).all(key) as { group_id: string }[]).map(
      (r) => r.group_id,
    ),
  );
  const insert = db.prepare(INSERT_OTA);

  for (const g of groups) {
    if (known.has(g.group) || g.isRollBackToEmbedded) continue;
    let detail: EasGroupDetail | undefined;
    try {
      detail = await client.viewGroup(cwd, g.group);
    } catch (err) {
      out.errors.push(`update:view ${g.group.slice(0, 8)}: ${errText(err)}`);
      continue;
    }
    // No commit behind it (rollback, or published before gitCommitHash existed).
    if (detail === undefined || detail.commitSha === "" || detail.createdAt === "") continue;
    insert.run(
      g.group,
      key,
      eas.branch,
      detail.commitSha,
      detail.createdAt,
      detail.message || g.message,
      detail.platforms || g.platforms,
    );
    known.add(g.group);
    out.added += 1;
  }
  return out;
}

/** Cached OTA updates for a repo's branch, oldest → newest. */
export function otaUpdatesFor(db: Db, repo: RepoKey, branch: string): OtaUpdateRow[] {
  return db
    .prepare(
      `SELECT group_id, repo, branch, commit_sha, created_at, message, platforms
         FROM ota_updates WHERE repo = ? AND branch = ?
        ORDER BY created_at ASC, group_id ASC`,
    )
    .all(repo, branch) as OtaUpdateRow[];
}

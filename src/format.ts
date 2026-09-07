/**
 * Presentation helpers for the CLI. No dependencies, no I/O — just strings
 * (bar `homedir()`, which only reads the environment).
 */
import { homedir } from "node:os";
import type { CiState, Config, RepoKey } from "./types.js";

/** Last path segment of an "owner/name" repo key. */
export function repoShortName(repo: RepoKey): string {
  const i = repo.lastIndexOf("/");
  return i === -1 ? repo : repo.slice(i + 1);
}

/** Use the repository name as its display label. */
export function repoLabel(repo: RepoKey): string {
  return repoShortName(repo);
}

/**
 * "https://linear.app/example/issue/PS-77", or undefined when either the
 * workspace slug or the issue key is missing. No workspace = no links anywhere.
 */
export function linearUrl(cfg: Pick<Config, "linear_workspace">, key: string | null): string | undefined {
  const workspace = cfg.linear_workspace;
  if (!workspace || !key) return undefined;
  return `https://linear.app/${workspace}/issue/${key}`;
}

export function shortSha(sha: string | null | undefined, len = 7): string {
  return sha ? sha.slice(0, len) : "";
}

export function ciGlyph(ci: CiState | null): string {
  switch (ci) {
    case "SUCCESS":
      return "✓";
    case "FAILURE":
    case "ERROR":
      return "✗";
    case "PENDING":
    case "EXPECTED":
      return "⏳";
    default:
      return "";
  }
}

/** Pad every column to its widest cell (the last column is left ragged). */
export function table(rows: readonly (readonly string[])[], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const sep = " ".repeat(gap);
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join(sep)
      .trimEnd(),
  );
}

/** "3h ago". Falls back to the raw string for unparseable input. */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

/** "/Users/me/Projects/x" -> "~/Projects/x". Other paths pass through. */
export function tildePath(p: string, home: string = homedir()): string {
  if (home !== "" && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

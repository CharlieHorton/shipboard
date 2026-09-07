import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, RepoConfig, RepoKey } from "./types.js";
import { repoKey } from "./types.js";

/** Root data dir. Override with SHIPBOARD_HOME (tests, alternate profiles). */
export function shipboardHome(): string {
  return process.env["SHIPBOARD_HOME"] ?? join(homedir(), ".shipboard");
}

export function configPath(): string {
  return join(shipboardHome(), "config.json");
}

export const DEFAULT_CONFIG: Config = {
  gating_bots: ["coderabbitai", "qodo-code-review"],
  ignored_authors: ["dependabot"],
  projects: [],
};

/** Load config, writing the default file on first run. */
export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) {
    mkdirSync(shipboardHome(), { recursive: true });
    writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
  return {
    gating_bots: raw.gating_bots ?? DEFAULT_CONFIG.gating_bots,
    ignored_authors: raw.ignored_authors ?? DEFAULT_CONFIG.ignored_authors,
    ...(raw.linear_workspace !== undefined ? { linear_workspace: raw.linear_workspace } : {}),
    projects: raw.projects ?? [],
  };
}

export function allRepos(cfg: Config): RepoConfig[] {
  return cfg.projects.flatMap((p) => p.repos);
}

export function findRepo(cfg: Config, key: RepoKey): RepoConfig | undefined {
  return allRepos(cfg).find((r) => repoKey(r) === key);
}

export function projectForRepo(cfg: Config, key: RepoKey): string | undefined {
  return cfg.projects.find((p) => p.repos.some((r) => repoKey(r) === key))?.name;
}

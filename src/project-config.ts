/** Project registration uses local Git observations and preserves user-authored config. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { configPath, DEFAULT_CONFIG } from "./config.js";
import { parseGithubRemote } from "./github.js";
import { repoKey, type RepoConfig } from "./types.js";

export interface ProjectOptions {
  repo?: string;
  local?: string;
  devBranch?: string;
  prodBranch?: string;
  deploy?: string;
}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function repositoryKey(value: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match?.[1] || !match[2] || [".", ".."].includes(match[2])) {
    throw new Error("Repository must be a GitHub owner/name, for example your-org/your-repo.");
  }
  return { owner: match[1], name: match[2] };
}

/** No fetch, GitHub query, database access, or config write during discovery. */
export function discoverRepository(options: ProjectOptions, cwd = process.cwd()): RepoConfig {
  const explicit = options.repo === undefined ? undefined : repositoryKey(options.repo);
  let identity = explicit;
  let local: string | undefined;
  if (options.local !== undefined || explicit === undefined) {
    const input = options.local ?? cwd;
    const directory = resolve(input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input);
    if (git(directory, "rev-parse", "--is-inside-work-tree") !== "true") {
      throw new Error("No Git checkout found. Use --local /path/to/checkout or --repo owner/name.");
    }
    const remote = git(directory, "remote", "get-url", "origin");
    const detected = remote === undefined ? undefined : parseGithubRemote(remote);
    if (!detected) throw new Error("The checkout needs a GitHub origin remote. Use --repo owner/name alone for GitHub-only tracking.");
    identity = repositoryKey(repoKey(detected));
    if (explicit && repoKey(explicit).toLowerCase() !== repoKey(identity).toLowerCase()) {
      throw new Error("--repo does not match the checkout's GitHub origin remote.");
    }
    // Git lists the main checkout first, including when invoked from a linked worktree.
    const listed = git(directory, "-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z");
    const first = listed?.split("\0")[0];
    local = first?.startsWith("worktree ") ? first.slice("worktree ".length) : undefined;
    if (!local || git(local, "rev-parse", "--is-inside-work-tree") !== "true") {
      throw new Error("Could not resolve an accessible main checkout for worktree tracking.");
    }
  }
  if (!identity) throw new Error("Could not resolve a GitHub repository.");
  const hasBranch = (name: string): boolean => local !== undefined &&
    ["heads", "remotes/origin"].some((prefix) => git(local!, "show-ref", "--verify", "--quiet", `refs/${prefix}/${name}`) !== undefined);
  const defaultRef = local === undefined ? undefined : git(local, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  const prod = options.prodBranch ?? defaultRef?.replace(/^refs\/remotes\/origin\//, "") ??
    (hasBranch("main") ? "main" : hasBranch("master") ? "master" : "main");
  const dev = options.devBranch ?? (hasBranch("develop") ? "develop" : prod);
  for (const [flag, branch] of [["--dev-branch", dev], ["--prod-branch", prod]]) {
    if (!branch || branch.startsWith("-") || branch.startsWith("refs/") ||
        branch.includes("@{") || git(cwd, "check-ref-format", "--branch", branch) === undefined) {
      throw new Error(`${flag} must be a valid short Git branch name.`);
    }
  }
  const deploy = options.deploy ?? "manual";
  if (deploy !== "manual" && deploy !== "auto") throw new Error("--deploy must be manual or auto.");
  return { ...identity, dev_branch: dev, prod_branch: prod, deploy, ...(local === undefined ? {} : { local }) };
}

// Passthrough preserves optional integrations and fields introduced by later versions.
const storedConfig = z.object({
  projects: z.array(z.object({
    name: z.string().min(1),
    repos: z.array(z.object({ owner: z.string().min(1), name: z.string().min(1) }).passthrough()),
  }).passthrough()).optional(),
}).passthrough();

/** Append one repository; an exclusive lock and atomic replacement protect other edits. */
export function addProjectRepository(project: string, repo: RepoConfig): string {
  const name = project.trim();
  if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Project name must be non-empty and contain no control characters.");
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error(`Cannot lock ${path}. Check permissions or whether another project command is running; a stale lock is at ${lockPath}.`);
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const exists = existsSync(path);
    let raw: unknown;
    try {
      raw = exists ? JSON.parse(readFileSync(path, "utf8")) : structuredClone(DEFAULT_CONFIG);
    } catch {
      throw new Error(`Cannot read valid JSON from ${path}; the existing file was not changed.`);
    }
    const result = storedConfig.safeParse(raw);
    if (!result.success) throw new Error(`Invalid projects in ${path}; the existing file was not changed.`);
    const config = result.data;
    const projects = config.projects ?? [];
    const key = repoKey(repo).toLowerCase();
    const owner = projects.find((p) => p.repos.some((r) => repoKey(r).toLowerCase() === key));
    if (owner) throw new Error(`${repoKey(repo)} is already registered in project "${owner.name}". Edit ${path} to change its settings.`);
    const existing = projects.find((p) => p.name === name);
    if (existing) existing.repos.push({ ...repo });
    else projects.push({ name, repos: [{ ...repo }] });
    const mode = exists ? statSync(path).mode & 0o777 : 0o600;
    writeFileSync(temporary, JSON.stringify({ ...config, projects }, null, 2) + "\n", { flag: "wx", mode });
    renameSync(temporary, path);
    return path;
  } finally {
    rmSync(temporary, { force: true });
    closeSync(lock);
    rmSync(lockPath);
  }
}

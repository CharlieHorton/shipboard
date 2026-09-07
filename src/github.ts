/**
 * GitHub access for Shipboard.
 *
 * Everything goes through the (already authenticated) `gh` CLI via execFile:
 * no local clones, no tokens in this process. GraphQL for PR state, REST
 * `compare` for reachability.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { allRepos } from "./config.js";
import type { Config, RepoConfig } from "./types.js";
import { repoKey } from "./types.js";

const execFileAsync = promisify(execFile);

/** gh output is filtered with --jq where it could be large, but be generous. */
const MAX_BUFFER = 64 * 1024 * 1024;

export class GhError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], stderr: string, cause?: unknown) {
    const detail = firstLine(stderr) || (cause instanceof Error ? cause.message : String(cause ?? ""));
    // Only the leading positional args: an inlined GraphQL document makes a useless message.
    const flagAt = args.findIndex((a) => a.startsWith("-"));
    const shown = flagAt === -1 ? args : args.slice(0, flagAt);
    super(`gh ${shown.join(" ")}: ${detail}`);
    this.name = "GhError";
    this.args = args;
    this.stderr = stderr;
  }
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, 300);
}

/** Run `gh` and return stdout. */
export async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr : "";
    throw new GhError(args, stderr, err);
  }
}

/** Run `gh` and parse its stdout as JSON. */
export async function ghJson(args: string[]): Promise<unknown> {
  const stdout = await gh(args);
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new GhError(args, `unparseable JSON output: ${stdout.slice(0, 200)}`);
  }
}

// ---------- GraphQL ----------

/** Per-PR selection. Verified against the live API 2026-09-03. */
const PR_FIELDS = `
    number title isDraft state baseRefName headRefName headRefOid mergedAt url
    author{login __typename}
    mergeCommit{oid}
    reviews(first:100){nodes{author{login __typename} commit{oid} state submittedAt}}
    reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login}}}}}
    commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}`;

/** One query per repo: open PRs plus recently-updated merged PRs. */
export const PRS_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    open: pullRequests(first:50,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{${PR_FIELDS}
      }
    }
    merged: pullRequests(first:30,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{${PR_FIELDS}
      }
    }
  }
}`;

/** Single PR, for linked PRs that have aged out of the batch. */
export const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){${PR_FIELDS}
    }
  }
}`;

// ---------- Wire shapes (only what we select) ----------

export interface GqlActor {
  login?: string | null;
  __typename?: string | null;
}

export interface GqlReview {
  author?: GqlActor | null;
  /** null when the review is not attached to a commit. */
  commit?: { oid?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
}

export interface GqlReviewThread {
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  comments?: { nodes?: ({ author?: GqlActor | null } | null)[] | null } | null;
}

export interface PrNode {
  number: number;
  title?: string | null;
  isDraft?: boolean | null;
  state?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  mergedAt?: string | null;
  url?: string | null;
  author?: GqlActor | null;
  mergeCommit?: { oid?: string | null } | null;
  reviews?: { nodes?: (GqlReview | null)[] | null } | null;
  reviewThreads?: { nodes?: (GqlReviewThread | null)[] | null } | null;
  commits?: { nodes?: ({ commit?: { oid?: string | null; statusCheckRollup?: { state?: string | null } | null } | null } | null)[] | null } | null;
}

/** Open + recently merged PRs for one repo. */
export interface PrBatch {
  open: PrNode[];
  merged: PrNode[];
}

/** The two fields of REST compare we care about. */
export interface CompareResult {
  ahead_by: number;
  status: string;
}

/**
 * Everything sync needs from GitHub. `ghClient` is the real implementation;
 * tests inject a fake so no test touches the network.
 */
export interface GithubClient {
  fetchPrs(repo: RepoConfig): Promise<PrBatch>;
  fetchPr(repo: RepoConfig, number: number): Promise<PrNode | undefined>;
  /** REST compare; throws (e.g. 404 for an unknown sha) rather than guessing. */
  compare(repo: RepoConfig, base: string, head: string): Promise<CompareResult>;
}

function nodes<T>(container: { nodes?: (T | null)[] | null } | null | undefined): T[] {
  return (container?.nodes ?? []).filter((n): n is T => n != null);
}

export const ghClient: GithubClient = {
  async fetchPrs(repo) {
    const raw = await ghJson([
      "api",
      "graphql",
      "-F",
      `owner=${repo.owner}`,
      "-F",
      `name=${repo.name}`,
      "-f",
      `query=${PRS_QUERY}`,
    ]);
    const rep = (raw as { data?: { repository?: { open?: { nodes?: (PrNode | null)[] }; merged?: { nodes?: (PrNode | null)[] } } | null } }).data
      ?.repository;
    return { open: nodes<PrNode>(rep?.open), merged: nodes<PrNode>(rep?.merged) };
  },

  async fetchPr(repo, number) {
    const raw = await ghJson([
      "api",
      "graphql",
      "-F",
      `owner=${repo.owner}`,
      "-F",
      `name=${repo.name}`,
      "-F",
      `number=${number}`,
      "-f",
      `query=${PR_QUERY}`,
    ]);
    const pr = (raw as { data?: { repository?: { pullRequest?: PrNode | null } | null } }).data?.repository?.pullRequest;
    return pr ?? undefined;
  },

  async compare(repo, base, head) {
    // --jq keeps the (potentially huge) file list out of stdout.
    const raw = await ghJson([
      "api",
      `repos/${repo.owner}/${repo.name}/compare/${base}...${head}`,
      "--jq",
      "{ahead_by: .ahead_by, status: .status}",
    ]);
    const r = raw as { ahead_by?: unknown; status?: unknown };
    if (typeof r.ahead_by !== "number") throw new GhError(["api", "compare"], `unexpected compare response for ${base}...${head}`);
    return { ahead_by: r.ahead_by, status: typeof r.status === "string" ? r.status : "" };
  },
};

// ---------- Local checkout → configured repo ----------

/** Parse the owner/name out of a GitHub remote URL (ssh, scp-style or https). */
export function parseGithubRemote(url: string): { owner: string; name: string } | undefined {
  let s = url.trim();
  if (!s) return undefined;
  s = s.replace(/\/+$/, "");
  const m =
    /^(?:git@github\.com:|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git:\/\/github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/(.+)$/.exec(
      s,
    );
  if (!m) return undefined;
  const owner = m[1];
  let name = m[2];
  if (!owner || !name) return undefined;
  if (name.endsWith(".git")) name = name.slice(0, -4);
  if (!name || name.includes("/")) return undefined;
  return { owner, name };
}

/** Resolve a local git checkout to a configured repo via `git remote get-url origin`. */
export function repoForCwd(cwd: string, cfg: Config): RepoConfig | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const parsed = parseGithubRemote(url);
  if (!parsed) return undefined;
  const key = repoKey(parsed).toLowerCase();
  return allRepos(cfg).find((r) => repoKey(r).toLowerCase() === key);
}

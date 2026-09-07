/**
 * Shared domain types for Shipboard.
 *
 * Principle: derive everything GitHub already knows; store only what it cannot.
 * `PrRow` fields are derived by the sync engine (src/sync.ts) and never hand-edited.
 * `ItemRow`, `TaskRow`, `EventRow` are authored by Claude or the user.
 */

// ---------- Config (from ~/.shipboard/config.json) ----------

export type DeployMode = "auto" | "manual";

export interface RepoConfig {
  owner: string;
  name: string;
  /** Branch that auto-deploys to the dev environment. May equal prod_branch (e.g. mobile app). */
  dev_branch: string;
  /** Branch that ships to production. */
  prod_branch: string;
  /** How prod_branch reaches production. "manual" means prod state is asserted, never derived. */
  deploy: DeployMode;
  /**
   * Main local checkout. Enables worktree tracking: `git worktree list` runs
   * here and every worktree of this repo is recorded in `worktrees`.
   */
  local?: string;
  /**
   * Expo EAS Update: OTA groups published on `branch` mark PRs as deployed
   * (`prs.deployed_at`). `cwd` is a local checkout the `eas` CLI runs in.
   */
  eas?: EasConfig;
}

export interface EasConfig {
  cwd: string;
  /** EAS branch that reaches real users, e.g. "production". */
  branch: string;
}

export interface ProjectConfig {
  name: string;
  repos: RepoConfig[];
}

export interface Config {
  /** GitHub logins (without "[bot]") whose reviews gate the pipeline. */
  gating_bots: string[];
  /** PR author logins to hide from default listings (dependabot etc). */
  ignored_authors: string[];
  /** Linear workspace slug for issue links (https://linear.app/<slug>/issue/<key>). */
  linear_workspace?: string;
  projects: ProjectConfig[];
}

/** "owner/name" — the key used in prs.repo and items.repo_order. */
export type RepoKey = string;

export function repoKey(r: Pick<RepoConfig, "owner" | "name">): RepoKey {
  return `${r.owner}/${r.name}`;
}

// ---------- Stages ----------

/** Fully derived from GitHub state; see src/stage.ts. */
export type PrStage =
  | "drafting" // draft PR
  | "awaiting-review" // ready PR, no gating-bot review on any commit yet
  | "awaiting-re-review" // pushed since last round, gating bots not yet reviewed head
  | "needs-addressing" // unresolved gating-bot threads on current head → agent acts
  | "ci-failing" // bots done, CI FAILURE/ERROR on head → agent acts
  | "awaiting-ci" // bots done, CI PENDING/EXPECTED on head
  | "ready-to-merge" // 0 unresolved threads, bots reviewed head, CI green → human decides
  | "merged-develop" // merged into dev_branch
  | "in-release" // merge commit reachable from an open dev→prod release PR head
  | "merged-main" // merge commit reachable from prod_branch (prod deploy pending)
  | "closed"; // closed without merge; ignored for item stage

/** Local observations remain independent of any PR for the same branch. */
export type WorktreeStage =
  | "unknown" // local status or commit comparison could not be established
  | "local-only" // uncommitted or unpushed work, even when a PR exists
  | "needs-pr" // pushed, commits ahead of dev, no PR
  | "has-pr" // an open PR exists and no local work is outstanding
  | "empty" // no commits ahead of dev, no PR → housekeeping
  | "merged"; // clean, fully observed checkout at the merged PR head

export type ItemStage =
  | "local-only"
  | "needs-pr"
  | Exclude<PrStage, "closed">
  | "needs-testing" // all PRs merged to dev and on dev, no completed test task
  | "tested" // reachable only via stage_override
  | "needs-release" // tested, sitting in dev_branch with no open release PR
  | "needs-prod-deploy" // all PRs merged-main, prod deploy not yet asserted
  | "needs-post-deploy" // on prod, verification or open tasks remain
  | "done" // on prod, no open tasks
  | "blocked"; // blocked_reason set

export const PR_STAGES: readonly PrStage[] = [
  "drafting",
  "awaiting-review",
  "awaiting-re-review",
  "needs-addressing",
  "ci-failing",
  "awaiting-ci",
  "ready-to-merge",
  "merged-develop",
  "in-release",
  "merged-main",
  "closed",
];

export const ITEM_STAGES: readonly ItemStage[] = [
  "local-only",
  "needs-pr",
  "drafting",
  "awaiting-review",
  "awaiting-re-review",
  "needs-addressing",
  "ci-failing",
  "awaiting-ci",
  "ready-to-merge",
  "merged-develop",
  "needs-testing",
  "tested",
  "needs-release",
  "in-release",
  "merged-main",
  "needs-prod-deploy",
  "needs-post-deploy",
  "done",
  "blocked",
];

/** Who must act for an item in this stage. `null` = nobody, it is waiting on bots/CI. */
export type Actor = "agent" | "human";

// ---------- Rows (SQLite) ----------

export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type CiState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
export type TaskKind = "test" | "flag" | "env" | "migration" | "changelog" | "helpbot" | "other";
export const TASK_KINDS: readonly TaskKind[] = ["test", "flag", "env", "migration", "changelog", "helpbot", "other"];
export type EventSource = "hook" | "mcp" | "sync" | "user";

export interface ItemRow {
  id: number;
  project: string;
  title: string;
  summary: string | null;
  /** JSON array of strings. */
  changes: string | null;
  linear_key: string | null;
  /**
   * Silo name (the feature directory holding one worktree per repo, e.g.
   * "contractor-profiles" for ~/Projects/example-features/contractor-profiles/*).
   * Worktrees with this silo attach to the item even before a PR exists.
   */
  silo: string | null;
  /** JSON array of RepoKey in required merge order. */
  repo_order: string | null;
  stage_override: ItemStage | null;
  blocked_reason: string | null;
  /** ISO timestamp; set by `shipboard deployed <item> prod`. Prod is asserted, not derived. */
  prod_deployed_at: string | null;
  /** Versioned JSON snapshot of the PR commits confirmed deployed; absent on legacy rows. */
  prod_deploy_evidence?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PrRow {
  id: number;
  item_id: number | null;
  repo: RepoKey;
  number: number;
  title: string;
  author: string;
  url: string;
  head_branch: string;
  base_branch: string;
  head_sha: string;
  state: PrState;
  is_draft: 0 | 1;
  /** Distinct head SHAs that received a gating-bot review. */
  review_round: number;
  /** Unresolved, non-outdated review threads opened by a gating bot. */
  unresolved_bot_threads: number;
  /** A gating bot has reviewed the current head_sha. */
  bot_reviews_on_head: 0 | 1;
  /** null = no checks reported (treated as green). */
  ci_state: CiState | null;
  merged_at: string | null;
  merge_sha: string | null;
  /** Number of the open dev→prod release PR whose head contains merge_sha, else null. */
  in_release_pr: number | null;
  /** merge_sha reachable from dev_branch. */
  on_dev: 0 | 1;
  /** merge_sha reachable from prod_branch. */
  on_prod: 0 | 1;
  /**
   * When this PR's merge commit reached real users, where the tracker can see
   * it (EAS OTA update on the repo's `eas.branch`). Null for manual deploys.
   */
  deployed_at: string | null;
  /** What shipped it, e.g. the EAS update group id. */
  deploy_ref: string | null;
  synced_at: string;
}

/** One local git worktree of a configured repo, refreshed by sync. Fully derived. */
export interface WorktreeRow {
  /** Absolute path; primary key. */
  path: string;
  repo: RepoKey;
  branch: string;
  head_sha: string;
  /** Derived from the path: parent dir name for `<silo>/<repo>` layouts, else the dir name. */
  silo: string;
  /** 1 for the main checkout (`RepoConfig.local`). */
  is_main: 0 | 1;
  /** Commits on HEAD not on origin/<dev_branch>; -1 when unavailable or stale. */
  ahead_of_dev: number;
  /** Commits on HEAD not on origin/<branch> and not on origin/<dev_branch>; -1 when unknown. */
  unpushed: number;
  /** origin/<branch> exists. */
  on_origin: 0 | 1;
  /** `git status --porcelain` non-empty; -1 if the worktree could not be read. */
  dirty: -1 | 0 | 1;
  /** ISO committer date of HEAD. */
  last_commit_at: string;
  seen_at: string;
}

/** One EAS Update group seen on a repo's configured OTA branch. */
export interface OtaUpdateRow {
  group_id: string;
  repo: RepoKey;
  branch: string;
  commit_sha: string;
  created_at: string;
  message: string;
  /** Comma-separated: "android, ios". */
  platforms: string;
}

export interface TaskRow {
  id: number;
  item_id: number;
  kind: TaskKind;
  text: string;
  created_at: string;
  done_at: string | null;
  /** Versioned JSON snapshot of PR commits covered by a completed test. */
  completion_evidence?: string | null;
}

export interface EventRow {
  id: number;
  item_id: number;
  at: string;
  source: EventSource;
  text: string;
}

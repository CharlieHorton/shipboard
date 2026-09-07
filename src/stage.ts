/**
 * Stage derivation. Pure functions over rows + config; no I/O.
 *
 * PR stage is derived entirely from what GitHub told the sync engine.
 * Item stage is the least advanced of its open PRs, with the tracker-owned
 * stages (testing / release / deploy) layered on top and the item's local
 * worktrees underneath: a branch that never reached GitHub is the least
 * advanced state there is, and the only one that can be lost outright.
 */
import { findRepo } from "./config.js";
import { parseJsonArray } from "./store.js";
import { repoLabel } from "./format.js";
import { manualDeployCoversCurrentPrs, testsPassForCurrentPrs } from "./evidence.js";
import type {
  Actor,
  Config,
  ItemRow,
  ItemStage,
  PrRow,
  PrStage,
  RepoConfig,
  TaskRow,
  WorktreeRow,
  WorktreeStage,
} from "./types.js";

/** Stage of a PR that has not been closed. */
export type ActivePrStage = Exclude<PrStage, "closed">;

/**
 * Low = less advanced. `needs-addressing` and `ci-failing` deliberately rank
 * below the waiting stages: an item with one PR an agent can act on should
 * surface as actionable rather than as "waiting on bots".
 */
const PR_STAGE_RANK: Record<PrStage, number> = {
  drafting: 0,
  "needs-addressing": 1,
  "ci-failing": 2,
  "awaiting-review": 3,
  "awaiting-re-review": 4,
  "awaiting-ci": 5,
  "ready-to-merge": 6,
  "merged-develop": 7,
  "in-release": 8,
  "merged-main": 9,
  closed: 99,
};

/**
 * The stages a local branch can contribute, ranked below every PR stage: work
 * that is not on GitHub at all is less advanced than a draft PR, and work that
 * is not on origin at all is the least advanced thing there is.
 */
const LOCAL_STAGE_RANK: Record<"local-only" | "needs-pr", number> = {
  "local-only": -2,
  "needs-pr": -1,
};

/** Rank of any stage an item can be fronted by before the tracker-owned ones. */
export function stageRank(s: PrStage | "local-only" | "needs-pr"): number {
  return s === "local-only" || s === "needs-pr" ? LOCAL_STAGE_RANK[s] : PR_STAGE_RANK[s];
}

export function prStageRank(s: PrStage): number {
  return PR_STAGE_RANK[s];
}

export function prStage(pr: PrRow, repo: RepoConfig | undefined): PrStage {
  if (pr.state === "CLOSED") return "closed";
  if (pr.state === "MERGED") {
    if (pr.on_prod) return "merged-main";
    // Merged straight into the prod branch (e.g. tenants, where
    // dev_branch === prod_branch === main): there is no release step.
    if (repo && pr.base_branch === repo.prod_branch) return "merged-main";
    if (pr.in_release_pr != null) return "in-release";
    return "merged-develop";
  }
  // OPEN
  if (pr.is_draft) return "drafting";
  if (pr.review_round === 0) return "awaiting-review";
  if (!pr.bot_reviews_on_head) return "awaiting-re-review";
  if (pr.unresolved_bot_threads > 0) return "needs-addressing";
  if (pr.ci_state === "FAILURE" || pr.ci_state === "ERROR") return "ci-failing";
  if (pr.ci_state === "PENDING" || pr.ci_state === "EXPECTED") return "awaiting-ci";
  return "ready-to-merge"; // SUCCESS, or no checks reported at all
}

interface ActivePr {
  pr: PrRow;
  repo: RepoConfig | undefined;
  stage: ActivePrStage;
}

function activePrs(prs: PrRow[], cfg: Config): ActivePr[] {
  const out: ActivePr[] = [];
  for (const pr of prs) {
    const repo = findRepo(cfg, pr.repo);
    const stage = prStage(pr, repo);
    if (stage === "closed") continue;
    out.push({ pr, repo, stage });
  }
  return out;
}

/**
 * Stage of a local worktree/branch. Local changes remain actionable even when
 * an old or current PR exists. Cleanup requires known clean status and known
 * commit comparisons; a merged PR only covers the head it actually merged.
 */
export function worktreeStage(wt: WorktreeRow, pr: PrRow | undefined): WorktreeStage {
  if (wt.dirty === 1 || wt.unpushed > 0) return "local-only";
  if (wt.dirty !== 0 || wt.ahead_of_dev < 0 || wt.unpushed < 0 || !wt.head_sha) return "unknown";
  if (pr?.state === "OPEN") return "has-pr";
  if (pr?.state === "MERGED" && pr.head_sha === wt.head_sha) return "merged";
  if (wt.ahead_of_dev === 0) return "empty";
  return "needs-pr";
}

export function itemStage(
  item: ItemRow,
  prs: PrRow[],
  tasks: TaskRow[],
  cfg: Config,
  worktrees: WorktreeRow[] = [],
): ItemStage {
  // 1. Blocked wins over everything.
  if (item.blocked_reason && item.blocked_reason.trim() !== "") return "blocked";
  // 2. A manual override is taken verbatim.
  if (item.stage_override) return item.stage_override;

  // 3. Closed PRs do not count. The item's local worktrees are staged next to
  //    them: a branch with no PR is still work, and the only work that can be
  //    lost outright.
  const active = activePrs(prs, cfg);
  const local = worktrees
    .filter((w) => w.is_main !== 1)
    .map((w) => worktreeStage(w, prs.find((p) => p.repo === w.repo && p.head_branch === w.branch)));

  // 3a. Commits that exist on this machine and nowhere else outrank everything:
  //     deleting the worktree deletes the work.
  if (local.includes("local-only")) return "local-only";

  // 3b. No live PR: either a pushed branch waiting for one, or plain drafting
  //     (nothing local, or only empty/merged leftovers).
  if (active.length === 0) return local.includes("needs-pr") ? "needs-pr" : "drafting";

  // 4. Least advanced PR, while any PR is still pre-merge.
  let min: ActivePrStage = active[0]!.stage;
  for (const a of active) if (prStageRank(a.stage) < prStageRank(min)) min = a.stage;

  // 4a. A pushed branch with no PR is unfinished work, but it must not hide a
  //     PR somebody still has to act on: it only surfaces once every PR of the
  //     item is ready to merge or already merged.
  if (local.includes("needs-pr") && stageRank(min) >= stageRank("ready-to-merge")) return "needs-pr";

  if (prStageRank(min) < prStageRank("merged-develop")) return min;

  // 5. Everything is merged, but the dev deploy has not landed yet. PRs already
  //    on prod are exempt: a release PR's own merge commit lives only on main.
  if (active.some((a) => a.stage !== "merged-main" && !a.pr.on_dev)) return "merged-develop";

  // 6. Reaching the prod branch takes precedence over missing test evidence:
  //    verification cannot move already-released work back into develop.
  const testDone = testsPassForCurrentPrs(tasks, prs);

  // 7. All the way to the prod branch. Prod is asserted by hand,
  //    except where the tracker can see the deploy itself: an EAS OTA update
  //    carrying every PR's merge commit counts as the assertion.
  if (active.every((a) => a.stage === "merged-main")) {
    const shipped = manualDeployCoversCurrentPrs(item, prs) || active.every((a) => a.pr.deployed_at !== null);
    if (!shipped) return "needs-prod-deploy";
    if (!testDone || tasks.some((t) => t.done_at == null)) return "needs-post-deploy";
    return "done";
  }

  // Still on dev: verification is needed before preparing the release.
  if (!testDone) return "needs-testing";

  // 8. Tested, sitting in a dev branch that still needs a release PR.
  if (active.some((a) => a.stage === "merged-develop" && a.repo && a.repo.dev_branch !== a.repo.prod_branch)) {
    return "needs-release";
  }

  // 9. Riding an open release PR.
  return "in-release";
}

// local-only and needs-pr are agent work: an agent can push the branch and
// open the PR without a decision from anyone.
const AGENT_STAGES: ReadonlySet<ItemStage> = new Set<ItemStage>([
  "local-only",
  "needs-pr",
  "needs-addressing",
  "ci-failing",
]);
const HUMAN_STAGES: ReadonlySet<ItemStage> = new Set<ItemStage>([
  "ready-to-merge",
  "needs-testing",
  "needs-release",
  "needs-prod-deploy",
  "needs-post-deploy",
  "blocked",
]);

/** Who must act. `null` means it is waiting on bots, CI or a deploy. */
export function actorFor(stage: ItemStage): Actor | null {
  if (AGENT_STAGES.has(stage)) return "agent";
  if (HUMAN_STAGES.has(stage)) return "human";
  return null;
}

/**
 * Warn when a PR later in `items.repo_order` is ready to merge while a PR from
 * an earlier repo has not merged yet (API before web).
 */
export function mergeOrderWarnings(item: ItemRow, prs: PrRow[], cfg: Config): string[] {
  const order = parseJsonArray(item.repo_order);
  if (order.length < 2) return [];
  const position = new Map(order.map((key, i) => [key, i] as const));

  const staged = prs.map((pr) => ({ pr, stage: prStage(pr, findRepo(cfg, pr.repo)) }));
  const warnings: string[] = [];
  for (const later of staged) {
    const li = position.get(later.pr.repo);
    if (li === undefined || later.stage !== "ready-to-merge") continue;
    for (const earlier of staged) {
      const ei = position.get(earlier.pr.repo);
      if (ei === undefined || ei >= li) continue;
      if (prStageRank(earlier.stage) >= prStageRank("merged-develop")) continue;
      warnings.push(
        `${repoLabel(later.pr.repo)}#${later.pr.number} is ready to merge but ` +
          `${repoLabel(earlier.pr.repo)}#${earlier.pr.number} must merge first`,
      );
    }
  }
  return warnings;
}

/**
 * Read models shared by the CLI, the MCP server and the hook: an item or PR
 * with its derived stage, and the sections `ls` prints. No rendering here.
 */
import { findRepo, projectForRepo } from "./config.js";
import { isAbsolute } from "node:path";
import { expandHome } from "./eas.js";
import { itemActions, nextActions, prActions } from "./actions.js";
import type { Db } from "./db.js";
import { actorFor, itemStage, mergeOrderWarnings, prStage, worktreeStage } from "./stage.js";
import { testsPassForCurrentPrs } from "./evidence.js";
import * as store from "./store.js";
import type {
  Actor,
  Config,
  ItemRow,
  ItemStage,
  PrRow,
  PrStage,
  RepoKey,
  WorktreeRow,
  WorktreeStage,
} from "./types.js";

export interface PrView {
  pr: PrRow;
  stage: PrStage;
}

/** A local worktree with its derived stage and the PR for its branch, if any. */
export interface WorktreeView {
  wt: WorktreeRow;
  stage: WorktreeStage;
  pr: PrRow | undefined;
  /** Owning repository's configured main checkout, for cwd-independent commands. */
  main_checkout?: string;
}

export interface ItemView {
  item: ItemRow;
  stage: ItemStage;
  actor: Actor | null;
  prs: PrView[];
  /** Worktrees attached by branch→PR or silo; main local work requires an explicit linked PR. */
  worktrees: WorktreeView[];
  warnings: string[];
  /** Outstanding verification of merged work, independent of release/deploy stage. */
  needs_testing?: boolean;
}

export function viewPr(pr: PrRow, cfg: Config): PrView {
  return { pr, stage: prStage(pr, findRepo(cfg, pr.repo)) };
}

/** Stage one worktree, finding the PR for its branch. */
export function viewWorktree(db: Db, wt: WorktreeRow, cfg?: Config): WorktreeView {
  const pr = store.findPrByBranch(db, wt.repo, wt.branch);
  const local = cfg ? findRepo(cfg, wt.repo)?.local : undefined;
  const main = local ? expandHome(local) : undefined;
  return { wt, stage: worktreeStage(wt, pr), pr,
    ...(main && isAbsolute(main) ? { main_checkout: main } : {}) };
}

/** All feature worktrees, plus main checkouts with local work or unknown state. */
export function worktreeViews(db: Db, cfg: Config): WorktreeView[] {
  return store
    .listWorktrees(db)
    .map((wt) => viewWorktree(db, wt, cfg))
    .filter((v) => !v.wt.is_main || v.stage === "local-only" || v.stage === "unknown");
}

/** Does this worktree belong to `item` — by a PR the item owns, or by silo? */
function matchesItem(wt: WorktreeRow, item: ItemRow, prs: PrRow[], cfg: Config): boolean {
  if (item.silo !== null && item.silo !== "" && item.silo === wt.silo && projectForRepo(cfg, wt.repo) === item.project) return true;
  return prs.some((pr) => pr.repo === wt.repo && pr.head_branch === wt.branch);
}

export function viewItem(db: Db, cfg: Config, item: ItemRow): ItemView {
  const prs = store.prsForItem(db, item.id);
  const tasks = store.tasksForItem(db, item.id);
  const active = prs.filter((pr) => pr.state !== "CLOSED");
  const worktrees = worktreeViews(db, cfg).filter((v) =>
    v.wt.is_main ? v.pr?.item_id === item.id : matchesItem(v.wt, item, prs, cfg),
  );
  const stage = itemStage(
    item,
    prs,
    tasks,
    cfg,
    worktrees.map((v) => v.wt),
  );
  return {
    item,
    stage,
    actor: actorFor(stage),
    prs: prs.map((pr) => viewPr(pr, cfg)),
    worktrees,
    warnings: mergeOrderWarnings(item, prs, cfg),
    needs_testing: active.length > 0 && active.every((pr) => pr.state === "MERGED") && !testsPassForCurrentPrs(tasks, prs),
  };
}

/** An open dev→prod PR: the release train itself, not a piece of work. */
export function isReleasePr(pr: PrRow, cfg: Config): boolean {
  const repo = findRepo(cfg, pr.repo);
  if (!repo || repo.dev_branch === repo.prod_branch) return false;
  return pr.head_branch === repo.dev_branch && pr.base_branch === repo.prod_branch;
}

/** PR stages worth surfacing for PRs nothing is tracking. */
export const ATTENTION_PR_STAGES: ReadonlySet<PrStage> = new Set<PrStage>([
  "needs-addressing",
  "ci-failing",
  "ready-to-merge",
]);

/** Worktree stages worth surfacing for worktrees no item tracks. */
export const ATTENTION_WORKTREE_STAGES: ReadonlySet<WorktreeStage> = new Set<WorktreeStage>([
  "local-only",
  "needs-pr",
  "unknown",
]);

/** Nothing is ahead of the dev branch any more: the checkout can go. */
export const HOUSEKEEPING_WORKTREE_STAGES: ReadonlySet<WorktreeStage> = new Set<WorktreeStage>([
  "empty",
  "merged",
]);

/** Worktrees with real work and no PR — the ones worth a line on an item. */
export function localWorktrees(views: readonly WorktreeView[]): WorktreeView[] {
  return views.filter((v) => ATTENTION_WORKTREE_STAGES.has(v.stage));
}

/** The count that matters for the stage: unpushed commits, else ahead of dev. */
export function worktreeCount(v: WorktreeView): number {
  return v.stage === "local-only" ? v.wt.unpushed : v.wt.ahead_of_dev;
}

/** Copyable POSIX-shell command. Never execute it here or rely on the caller's cwd. */
export function worktreeRemoveCommand(v: WorktreeView): string | undefined {
  if (!v.main_checkout || !isAbsolute(v.main_checkout) || !isAbsolute(v.wt.path) || v.wt.is_main ||
      !HOUSEKEEPING_WORKTREE_STAGES.has(v.stage) || v.wt.dirty !== 0 || v.wt.unpushed !== 0 || v.wt.ahead_of_dev < 0) return undefined;
  const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  return `git -C ${quote(v.main_checkout)} worktree remove -- ${quote(v.wt.path)}`;
}

export interface ReleaseView {
  view: PrView;
  /** PRs whose merge commit is contained in this release PR's head. */
  contains: number;
}

export interface WorktreeSections {
  /** Local work no item tracks, oldest commit first. */
  untracked: WorktreeView[];
  /** Nothing left ahead of dev: `git worktree remove` candidates, by path. */
  housekeeping: WorktreeView[];
}

export interface LsSections {
  items: ItemView[];
  unlinked: PrView[];
  release: ReleaseView[];
  worktrees: WorktreeSections;
}

export interface CollectOptions {
  project?: string;
  /** Include PRs from `cfg.ignored_authors`. */
  all?: boolean;
  archived?: boolean;
  /** Only items with an actor and unlinked PRs in ATTENTION_PR_STAGES. */
  attention?: boolean;
}

/** Silos claimed by an item; a worktree in one of them is already tracked. */
function claimedSilos(db: Db): Set<string> {
  const silos = new Set<string>();
  for (const item of store.listItems(db)) {
    if (item.silo !== null && item.silo !== "") silos.add(JSON.stringify([item.project, item.silo]));
  }
  return silos;
}

/** No item owns this worktree: no linked PR on its branch, and no item silo. */
function isUntracked(v: WorktreeView, silos: ReadonlySet<string>, activeIds: Set<number>, cfg: Config): boolean {
  if (v.pr && v.pr.item_id !== null && activeIds.has(v.pr.item_id)) return false;
  if (v.wt.is_main) return true; // Main work cannot be claimed indirectly by silo.
  return !silos.has(JSON.stringify([projectForRepo(cfg, v.wt.repo), v.wt.silo]));
}

export function collect(db: Db, cfg: Config, opts: CollectOptions = {}): LsSections {
  const listOpts: { project?: string; includeArchived?: boolean } = {};
  if (opts.project !== undefined) listOpts.project = opts.project;
  if (opts.archived) listOpts.includeArchived = true;
  let items = store.listItems(db, listOpts).map((i) => viewItem(db, cfg, i));

  const openPrs = store.listPrs(db, { state: "OPEN" }).filter(
    (pr) => opts.project === undefined || projectForRepo(cfg, pr.repo) === opts.project,
  );
  const allPrs = store.listPrs(db);
  const ignored = new Set(cfg.ignored_authors);

  const release: ReleaseView[] = openPrs
    .filter((pr) => isReleasePr(pr, cfg))
    .map((pr) => ({
      view: viewPr(pr, cfg),
      contains: allPrs.filter((p) => p.repo === pr.repo && p.in_release_pr === pr.number).length,
    }));

  let unlinked = openPrs
    .filter((pr) => pr.item_id === null && !isReleasePr(pr, cfg))
    .filter((pr) => opts.all || !ignored.has(pr.author))
    .map((pr) => viewPr(pr, cfg));

  const wts = worktreeViews(db, cfg).filter(
    (v) => opts.project === undefined || projectForRepo(cfg, v.wt.repo) === opts.project,
  );
  const silos = claimedSilos(db);
  const activeIds = new Set(store.listItems(db).map((item) => item.id));
  let untracked = wts
    .filter((v) => ATTENTION_WORKTREE_STAGES.has(v.stage) && isUntracked(v, silos, activeIds, cfg))
    .sort((a, b) => (a.wt.last_commit_at < b.wt.last_commit_at ? -1 : a.wt.last_commit_at > b.wt.last_commit_at ? 1 : 0));
  let housekeeping = wts
    .filter((v) => !v.wt.is_main && HOUSEKEEPING_WORKTREE_STAGES.has(v.stage) && v.wt.dirty === 0 && v.wt.unpushed === 0 && v.wt.ahead_of_dev >= 0)
    .sort((a, b) => (a.wt.path < b.wt.path ? -1 : a.wt.path > b.wt.path ? 1 : 0));

  if (opts.attention) {
    items = items.filter((v) => itemActions(v).length > 0);
    unlinked = unlinked.filter((v) => prActions(v).length > 0);
    // Housekeeping is tidying, never attention; only forgotten local work is.
    housekeeping = [];
  }
  return { items, unlinked, release, worktrees: { untracked, housekeeping } };
}

/** Group worktree views by silo, preserving input order. `""` → "(no silo)". */
export const NO_SILO = "(no silo)";

export function groupBySilo(views: readonly WorktreeView[]): Map<string, WorktreeView[]> {
  const out = new Map<string, WorktreeView[]>();
  for (const v of views) {
    const key = v.wt.silo === "" ? NO_SILO : v.wt.silo;
    const bucket = out.get(key);
    if (bucket) bucket.push(v);
    else out.set(key, [v]);
  }
  return out;
}

/** The PR for a branch and, if linked, its item view. */
export function lookupBranch(
  db: Db,
  cfg: Config,
  repo: RepoKey,
  branch: string,
): { pr: PrView; item: ItemView | undefined } | undefined {
  const pr = store.findPrByBranch(db, repo, branch);
  if (!pr) return undefined;
  const item = pr.item_id === null ? undefined : store.getItem(db, pr.item_id);
  return { pr: viewPr(pr, cfg), item: item ? viewItem(db, cfg, item) : undefined };
}

// ---------- JSON shapes (ls --json and the MCP tools share these) ----------

export function jsonPr(v: PrView): Record<string, unknown> {
  return { ...v.pr, stage: v.stage };
}

export function jsonWorktree(v: WorktreeView): Record<string, unknown> {
  return { ...v.wt, stage: v.stage, pr_number: v.pr?.number ?? null,
    main_checkout: v.main_checkout ?? null, remove_command: worktreeRemoveCommand(v) ?? null };
}

export function jsonItem(v: ItemView): Record<string, unknown> {
  return {
    ...v.item,
    changes: store.parseJsonArray(v.item.changes),
    repo_order: store.parseJsonArray(v.item.repo_order),
    stage: v.stage,
    actor: v.actor,
    prs: v.prs.map(jsonPr),
    worktrees: v.worktrees.map(jsonWorktree),
    warnings: v.warnings,
    actions: itemActions(v),
  };
}

export function jsonSections(s: LsSections): Record<string, unknown> {
  return {
    actions: nextActions(s),
    items: s.items.map(jsonItem),
    unlinked: s.unlinked.map(jsonPr),
    release: s.release.map((e) => ({ ...jsonPr(e.view), contains: e.contains })),
    worktrees: {
      untracked: s.worktrees.untracked.map(jsonWorktree),
      housekeeping: s.worktrees.housekeeping.map(jsonWorktree),
    },
  };
}

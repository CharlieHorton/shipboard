/**
 * Sync engine: GitHub → the `prs` table.
 *
 * One GraphQL call per repo for open + recently merged PRs, plus REST compares
 * for reachability of merged commits. Repos with an `eas` config additionally
 * get their OTA updates refreshed (src/eas.ts) and matched to merge commits, so
 * `prs.deployed_at` records the Expo deploy GitHub cannot see. Repos with a
 * `local` checkout also get their git worktrees refreshed (src/worktrees.ts),
 * which is the only way a branch that was never pushed reaches the tracker.
 * Everything here is derived; `prs.item_id` belongs to the user/CLI and is
 * never written by sync.
 */

import { allRepos } from "./config.js";
import type { Db } from "./db.js";
import { nowIso } from "./db.js";
import type { EasClient } from "./eas.js";
import { easClient, otaUpdatesFor, syncOtaUpdates } from "./eas.js";
import type { CompareResult, GithubClient, GqlActor, PrNode } from "./github.js";
import { ghClient } from "./github.js";
import type { CiState, Config, OtaUpdateRow, PrRow, PrState, RepoConfig, RepoKey } from "./types.js";
import { repoKey } from "./types.js";
import type { GitClient } from "./worktrees.js";
import { gitClient, syncWorktrees } from "./worktrees.js";
import { beginSync, finishSync } from "./sync-health.js";

export interface PrChange {
  repo: string;
  number: number;
  field: string;
  from: unknown;
  to: unknown;
}

export interface SyncResult {
  /** "owner/name" */
  repo: string;
  prs_seen: number;
  prs_changed: number;
  /** Local worktrees recorded this run; 0 for a repo with no `local` checkout. */
  worktrees_seen: number;
  changes: PrChange[];
  errors: string[];
}

/** Fields derived purely from one PR node (no network). */
export interface DerivedPr {
  number: number;
  title: string;
  author: string;
  url: string;
  head_branch: string;
  base_branch: string;
  head_sha: string;
  state: PrState;
  is_draft: 0 | 1;
  review_round: number;
  unresolved_bot_threads: number;
  bot_reviews_on_head: 0 | 1;
  ci_state: CiState | null;
  merged_at: string | null;
  merge_sha: string | null;
}

/** A derived PR plus the reachability fields that need REST compares. */
export interface PrRecord extends DerivedPr {
  in_release_pr: number | null;
  on_dev: 0 | 1;
  on_prod: 0 | 1;
  /** When an EAS OTA update first carried merge_sha to users. */
  deployed_at: string | null;
  /** The EAS update group that did it. */
  deploy_ref: string | null;
}

/** Fields diffed old-vs-new and reported in `changes`. */
const DIFF_FIELDS = [
  "state",
  "is_draft",
  "head_sha",
  "review_round",
  "unresolved_bot_threads",
  "bot_reviews_on_head",
  "ci_state",
  "merged_at",
  "in_release_pr",
  "on_dev",
  "on_prod",
  "deployed_at",
] as const;
type DiffField = (typeof DIFF_FIELDS)[number];

type StoredPr = Pick<PrRow, "number" | "item_id" | "merge_sha" | "deploy_ref" | DiffField>;

const CI_STATES = new Set<string>(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]);

/** Bounded concurrency for REST compares. */
const COMPARE_CONCURRENCY = 4;

// ---------- Derivation (pure) ----------

function list<T>(container: { nodes?: (T | null)[] | null } | null | undefined): T[] {
  return (container?.nodes ?? []).filter((n): n is T => n != null);
}

function loginOf(actor: GqlActor | null | undefined): string {
  const l = actor?.login;
  return typeof l === "string" ? l : "";
}

/**
 * Derive every per-PR field that needs no further network call.
 *
 * - review_round           distinct commit oids that received a gating-bot review
 * - bot_reviews_on_head    a gating bot reviewed headRefOid
 * - unresolved_bot_threads threads opened by a gating bot that are neither
 *                          resolved nor outdated (outdated lines have changed,
 *                          so they no longer gate)
 */
export function derivePrFields(node: PrNode, gatingBots: string[]): DerivedPr {
  const gating = new Set(gatingBots.map((b) => b.toLowerCase()));
  const isGating = (actor: GqlActor | null | undefined): boolean => {
    const login = loginOf(actor).toLowerCase();
    return login !== "" && gating.has(login);
  };

  const head = node.headRefOid ?? "";
  const roundOids = new Set<string>();
  let onHead = false;
  for (const review of list(node.reviews)) {
    if (!isGating(review.author)) continue;
    const oid = review.commit?.oid; // commit is null for some reviews
    if (typeof oid !== "string" || oid === "") continue;
    roundOids.add(oid);
    if (oid === head) onHead = true;
  }

  let unresolved = 0;
  for (const thread of list(node.reviewThreads)) {
    if (thread.isResolved === true || thread.isOutdated === true) continue;
    const first = list(thread.comments)[0];
    if (isGating(first?.author)) unresolved += 1;
  }

  const state: PrState = node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN";
  const rollup = list(node.commits)[0]?.commit?.statusCheckRollup?.state;
  const ci_state = typeof rollup === "string" && CI_STATES.has(rollup) ? (rollup as CiState) : null;
  const mergeOid = node.mergeCommit?.oid;

  return {
    number: node.number,
    title: node.title ?? "",
    author: loginOf(node.author),
    url: node.url ?? "",
    head_branch: node.headRefName ?? "",
    base_branch: node.baseRefName ?? "",
    head_sha: head,
    state,
    is_draft: node.isDraft === true ? 1 : 0,
    review_round: roundOids.size,
    unresolved_bot_threads: unresolved,
    bot_reviews_on_head: onHead ? 1 : 0,
    ci_state,
    merged_at: node.mergedAt ?? null,
    merge_sha: state === "MERGED" && typeof mergeOid === "string" ? mergeOid : null,
  };
}

/** The open PR that ships dev_branch → prod_branch, if any. */
export function findReleasePr(open: PrNode[], repo: RepoConfig): PrNode | undefined {
  if (repo.dev_branch === repo.prod_branch) return undefined;
  return open.find((n) => n.baseRefName === repo.prod_branch && n.headRefName === repo.dev_branch);
}

// ---------- Sync ----------

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

function loadStored(db: Db, repo: RepoKey): Map<number, StoredPr> {
  const rows = db
    .prepare(
      `SELECT number, item_id, merge_sha, deploy_ref, ${DIFF_FIELDS.join(", ")} FROM prs WHERE repo = ?`,
    )
    .all(repo) as StoredPr[];
  return new Map(rows.map((r) => [r.number, r]));
}

const UPSERT_SQL = `
INSERT INTO prs (repo, number, title, author, url, head_branch, base_branch, head_sha, state, is_draft,
                 review_round, unresolved_bot_threads, bot_reviews_on_head, ci_state, merged_at, merge_sha,
                 in_release_pr, on_dev, on_prod, deployed_at, deploy_ref, synced_at)
VALUES (@repo, @number, @title, @author, @url, @head_branch, @base_branch, @head_sha, @state, @is_draft,
        @review_round, @unresolved_bot_threads, @bot_reviews_on_head, @ci_state, @merged_at, @merge_sha,
        @in_release_pr, @on_dev, @on_prod, @deployed_at, @deploy_ref, @synced_at)
ON CONFLICT(repo, number) DO UPDATE SET
  title = excluded.title,
  author = excluded.author,
  url = excluded.url,
  head_branch = excluded.head_branch,
  base_branch = excluded.base_branch,
  head_sha = excluded.head_sha,
  state = excluded.state,
  is_draft = excluded.is_draft,
  review_round = excluded.review_round,
  unresolved_bot_threads = excluded.unresolved_bot_threads,
  bot_reviews_on_head = excluded.bot_reviews_on_head,
  ci_state = excluded.ci_state,
  merged_at = excluded.merged_at,
  merge_sha = excluded.merge_sha,
  in_release_pr = excluded.in_release_pr,
  on_dev = excluded.on_dev,
  on_prod = excluded.on_prod,
  deployed_at = excluded.deployed_at,
  deploy_ref = excluded.deploy_ref,
  synced_at = excluded.synced_at`;
// NB: item_id is deliberately absent from the UPDATE set — it is owned by the user/CLI.

/** Human-readable event lines for the changes that matter to a tracked item. */
function eventLines(
  repo: RepoKey,
  next: PrRecord,
  changed: Set<DiffField>,
  prev: StoredPr,
  ota: OtaUpdateRow | undefined,
): string[] {
  const label = `PR ${repo}#${next.number}`;
  const lines: string[] = [];

  if (changed.has("state")) {
    if (next.state === "MERGED") lines.push(`${label} merged into ${next.base_branch}`);
    else if (next.state === "CLOSED") lines.push(`${label} closed without merging`);
    else lines.push(`${label} reopened`);
  }
  if (changed.has("is_draft")) {
    lines.push(next.is_draft === 1 ? `${label} converted to draft` : `${label} marked ready for review`);
  }
  const threads = `${next.unresolved_bot_threads} unresolved bot thread${next.unresolved_bot_threads === 1 ? "" : "s"}`;
  if (changed.has("review_round") && next.review_round > prev.review_round) {
    lines.push(`${label} review round ${next.review_round} landed, ${threads}`);
  } else if (changed.has("unresolved_bot_threads")) {
    lines.push(next.unresolved_bot_threads === 0 ? `${label} all bot threads resolved` : `${label} now has ${threads}`);
  }
  if (changed.has("ci_state") && next.ci_state !== null) lines.push(`${label} CI ${next.ci_state}`);
  if (changed.has("on_dev") && next.on_dev === 1) lines.push(`${label} now on dev`);
  if (changed.has("in_release_pr") && next.in_release_pr !== null) {
    lines.push(`${label} included in release PR #${next.in_release_pr}`);
  }
  if (changed.has("on_prod") && next.on_prod === 1) lines.push(`${label} now on prod branch`);
  if (changed.has("deployed_at") && prev.deployed_at === null && next.deployed_at !== null) {
    const where = ota === undefined ? "" : ` ${ota.branch} (${ota.platforms})`;
    lines.push(`${label} shipped via OTA${where}`);
  }
  return lines;
}

/**
 * The oldest cached OTA update whose commit contains `mergeSha`, i.e. the
 * update that first shipped this PR.
 *
 * `updates` is oldest → newest and, on a single EAS branch, very nearly a
 * linear history, so the newest update is a one-compare test for "shipped at
 * all": if it does not contain the merge commit, nothing older can either.
 * When it does, walk backwards until the first update that does NOT contain it
 * and take the one after — with a shared `contains` memo per (base, sha) the
 * android/ios pair published from one commit costs a single extra compare.
 */
export async function firstOtaContaining(
  updates: OtaUpdateRow[],
  mergeSha: string,
  contains: (updateSha: string, mergeSha: string) => Promise<boolean>,
): Promise<OtaUpdateRow | undefined> {
  let i = updates.length - 1;
  const newest = updates[i];
  if (newest === undefined) return undefined;
  if (!(await contains(newest.commit_sha, mergeSha))) return undefined;

  let oldest = newest;
  for (i -= 1; i >= 0; i -= 1) {
    const update = updates[i];
    if (update === undefined) break;
    if (!(await contains(update.commit_sha, mergeSha))) break;
    oldest = update;
  }
  return oldest;
}

/** Sync one repo. Never throws for a GitHub failure; failures land in `errors`. */
export async function syncRepo(
  db: Db,
  repo: RepoConfig,
  cfg: Config,
  client: GithubClient = ghClient,
  eas: EasClient = easClient,
  git: GitClient = gitClient,
): Promise<SyncResult> {
  const key = repoKey(repo);
  const result: SyncResult = { repo: key, prs_seen: 0, prs_changed: 0, worktrees_seen: 0, changes: [], errors: [] };
  // Independent sources still refresh when GitHub is unavailable.
  if (repo.local !== undefined) {
    beginSync(db, key, "worktrees");
    const errors: string[] = [];
    try {
      const wt = await syncWorktrees(db, repo, git);
      result.worktrees_seen = wt.seen;
      errors.push(...wt.errors);
    } catch (err) {
      errors.push(errText(err));
    }
    finishSync(db, key, "worktrees", errors);
    result.errors.push(...errors.map((e) => `worktrees: ${e}`));
  }

  let otaUpdates: OtaUpdateRow[] = [];
  if (repo.eas) {
    beginSync(db, key, "eas");
    const errors: string[] = [];
    try {
      const ota = await syncOtaUpdates(db, repo, eas);
      errors.push(...ota.errors);
      otaUpdates = otaUpdatesFor(db, key, repo.eas.branch);
    } catch (err) {
      errors.push(errText(err));
    }
    finishSync(db, key, "eas", errors);
    result.errors.push(...errors.map((e) => `eas: ${e}`));
  }

  beginSync(db, key, "github");
  const beforeGithub = result.errors.length;
  try {
    await syncGithubRepo(db, repo, cfg, client, otaUpdates, result);
  } catch (err) {
    result.errors.push(errText(err));
  }
  finishSync(db, key, "github", result.errors.slice(beforeGithub));
  return result;
}

async function syncGithubRepo(
  db: Db,
  repo: RepoConfig,
  cfg: Config,
  client: GithubClient,
  otaUpdates: OtaUpdateRow[],
  result: SyncResult,
): Promise<void> {
  const key = repoKey(repo);
  const stored = loadStored(db, key);

  let open: PrNode[] = [];
  const byNumber = new Map<number, PrNode>();
  try {
    const batch = await client.fetchPrs(repo);
    open = batch.open;
    for (const node of [...batch.open, ...batch.merged]) {
      if (typeof node.number === "number") byNumber.set(node.number, node);
    }
  } catch (err) {
    result.errors.push(`fetch PRs: ${errText(err)}`);
    return;
  }

  // Linked history must never go stale. Also refresh cached OPEN PRs missing
  // from the batch: a closed unlinked PR otherwise stays actionable forever.
  for (const [number, row] of stored) {
    if (byNumber.has(number) || (row.item_id === null && row.state !== "OPEN")) continue;
    try {
      const node = await client.fetchPr(repo, number);
      if (node) byNumber.set(number, node);
      else result.errors.push(`PR #${number}: not found`);
    } catch (err) {
      result.errors.push(`PR #${number}: ${errText(err)}`);
    }
  }

  const releasePr = findReleasePr(open, repo);
  const releaseHead = typeof releasePr?.headRefOid === "string" ? releasePr.headRefOid : undefined;
  const releaseNumber = releasePr?.number;

  const derived = [...byNumber.values()].map((node) => derivePrFields(node, cfg.gating_bots));
  result.prs_seen = derived.length;

  /** PR number → the update that first shipped it, for the event line. */
  const shippedBy = new Map<number, OtaUpdateRow>();

  // --- reachability (merged PRs only), memoised per (base, sha) ---
  const compares = new Map<string, Promise<boolean | null>>();
  const reachable = (base: string, sha: string): Promise<boolean | null> => {
    const cacheKey = `${base}...${sha}`;
    let pending = compares.get(cacheKey);
    if (!pending) {
      pending = client
        .compare(repo, base, sha)
        .then((c: CompareResult) => c.ahead_by === 0)
        .catch((err: unknown) => {
          result.errors.push(`compare ${base}...${sha.slice(0, 7)}: ${errText(err)}`);
          return null; // unknown is not evidence of absence
        });
      compares.set(cacheKey, pending);
    }
    return pending;
  };

  const records = await mapPool(derived, COMPARE_CONCURRENCY, async (d): Promise<PrRecord> => {
    const prev = stored.get(d.number);
    // Shipping is monotonic: once an OTA carried a PR to users it stays shipped.
    let deployed_at = prev?.deployed_at ?? null;
    let deploy_ref = prev?.deploy_ref ?? null;
    const sha = d.merge_sha;
    if (d.state !== "MERGED" || sha === null) {
      return { ...d, in_release_pr: null, on_dev: 0, on_prod: 0, deployed_at, deploy_ref };
    }

    let reach: Pick<PrRecord, "in_release_pr" | "on_dev" | "on_prod">;
    // on_prod is monotonic too: once landed, stop paying for compares.
    if (prev?.on_prod === 1) {
      reach = { in_release_pr: prev.in_release_pr, on_dev: prev.on_dev, on_prod: 1 };
    } else {
      const onDev = await reachable(repo.dev_branch, sha);
      const onProd =
        repo.dev_branch === repo.prod_branch ? onDev : await reachable(repo.prod_branch, sha);
      // The release PR head is a dev_branch commit, so a sha that is not on dev
      // cannot be in it either — skip the call.
      const sameCommit = prev?.merge_sha === sha;
      let inRelease: number | null = (onDev === null || onProd === null) && sameCommit
        ? prev?.in_release_pr ?? null : null;
      if (releaseHead !== undefined && releaseNumber !== undefined && onDev === true && onProd === false) {
        const contained = await reachable(releaseHead, sha);
        inRelease = contained === null
          ? sameCommit ? prev?.in_release_pr ?? null : null
          : contained ? releaseNumber : null;
      }
      reach = { in_release_pr: inRelease,
        on_dev: onDev === null ? sameCommit ? prev?.on_dev ?? 0 : 0 : onDev ? 1 : 0,
        on_prod: onProd === null ? sameCommit ? prev?.on_prod ?? 0 : 0 : onProd ? 1 : 0 };
    }

    if (deployed_at === null && otaUpdates.length > 0) {
      // An unknown compare must not select a newer deployment as the first.
      // The failed compare has already been recorded in GitHub source health.
      const update = await firstOtaContaining(otaUpdates, sha, async (base, merge) => {
        const contained = await reachable(base, merge);
        if (contained === null) throw new Error("OTA containment unknown");
        return contained;
      }).catch(() => undefined);
      if (update !== undefined) {
        deployed_at = update.created_at;
        deploy_ref = update.group_id;
        shippedBy.set(d.number, update);
      }
    }
    return { ...d, ...reach, deployed_at, deploy_ref };
  });

  // --- persist + diff ---
  const synced_at = nowIso();
  const upsert = db.prepare(UPSERT_SQL);
  const addEvent = db.prepare(`INSERT INTO events (item_id, at, source, text) VALUES (?, ?, 'sync', ?)`);

  const write = db.transaction((rows: PrRecord[]) => {
    for (const next of rows) {
      const prev = stored.get(next.number);
      const changed = new Set<DiffField>();
      if (prev === undefined) {
        result.changes.push({ repo: key, number: next.number, field: "created", from: null, to: next.state });
        result.prs_changed += 1;
      } else {
        for (const field of DIFF_FIELDS) {
          if (prev[field] !== next[field]) {
            changed.add(field);
            result.changes.push({ repo: key, number: next.number, field, from: prev[field], to: next[field] });
          }
        }
        if (changed.size > 0) result.prs_changed += 1;
      }

      upsert.run({
        repo: key,
        number: next.number,
        title: next.title,
        author: next.author,
        url: next.url,
        head_branch: next.head_branch,
        base_branch: next.base_branch,
        head_sha: next.head_sha,
        state: next.state,
        is_draft: next.is_draft,
        review_round: next.review_round,
        unresolved_bot_threads: next.unresolved_bot_threads,
        bot_reviews_on_head: next.bot_reviews_on_head,
        ci_state: next.ci_state,
        merged_at: next.merged_at,
        merge_sha: next.merge_sha,
        in_release_pr: next.in_release_pr,
        on_dev: next.on_dev,
        on_prod: next.on_prod,
        deployed_at: next.deployed_at,
        deploy_ref: next.deploy_ref,
        synced_at,
      });

      if (prev?.item_id != null && changed.size > 0) {
        for (const line of eventLines(key, next, changed, prev, shippedBy.get(next.number))) {
          addEvent.run(prev.item_id, synced_at, line);
        }
      }
    }
  });
  write(records);

}

/** Sync every configured repo (or just `opts.repos`). One repo's failure never stops the rest. */
export async function syncAll(
  db: Db,
  cfg: Config,
  opts?: {
    repos?: RepoKey[] | undefined;
    client?: GithubClient | undefined;
    eas?: EasClient | undefined;
    git?: GitClient | undefined;
  },
): Promise<SyncResult[]> {
  const wanted = opts?.repos ? new Set(opts.repos.map((r) => r.toLowerCase())) : undefined;
  const repos = allRepos(cfg).filter((r) => wanted === undefined || wanted.has(repoKey(r).toLowerCase()));
  const client = opts?.client ?? ghClient;
  const eas = opts?.eas ?? easClient;
  const git = opts?.git ?? gitClient;

  const results: SyncResult[] = [];
  for (const repo of repos) {
    try {
      results.push(await syncRepo(db, repo, cfg, client, eas, git));
    } catch (err) {
      results.push({
        repo: repoKey(repo),
        prs_seen: 0,
        prs_changed: 0,
        worktrees_seen: 0,
        changes: [],
        errors: [errText(err)],
      });
    }
  }
  return results;
}

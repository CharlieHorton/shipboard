#!/usr/bin/env node
/**
 * Claude Code hook: PostToolUse on Bash, plus a SessionStart digest.
 *
 * PostToolUse — reads the tool event on stdin; when the Bash command was a
 * pipeline-moving one (`git push`, `gh pr create|merge|ready|comment`, a review
 * reply, an EAS build) it syncs just that repo and prints `additionalContext`
 * describing what the tracker now knows.
 *
 * SessionStart — prints the attention queue for the project owning `cwd`, at
 * most ten lines, and never syncs: startup must stay instant. Projects opt in by
 * simply being configured; an unconfigured cwd prints nothing.
 *
 * Nothing else ever reaches stdout, and any failure is swallowed: a broken hook
 * must never break the session.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, projectForRepo } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ciGlyph, relTime, repoLabel, table } from "./format.js";
import { repoForCwd } from "./github.js";
import * as store from "./store.js";
import { worktreeStage } from "./stage.js";
import { itemActions, nextActions, prActions } from "./actions.js";
import { readSyncHealth } from "./sync-health.js";
import { syncAll, type PrChange, type SyncResult } from "./sync.js";
import {
  collect,
  groupBySilo,
  isReleasePr,
  localWorktrees,
  viewItem,
  viewPr,
  lookupBranch,
  type ItemView,
  type LsSections,
  type PrView,
  type WorktreeView,
} from "./views.js";
import { repoKey, type CiState, type Config, type RepoConfig, type RepoKey } from "./types.js";

/** Hooks time out at 60 s; leave room to still emit something. */
const TIMEOUT_MS = 40_000;
const MAX_LINES = 6;
/** The SessionStart digest, header line included. Design doc says "~10 lines". */
const MAX_DIGEST_LINES = 10;

// ---------- decide (pure) ----------

export type HookKind = "push" | "pr-create" | "pr-merge" | "pr-ready" | "pr-comment" | "pr-reply" | "eas";

export interface Decision {
  kind: HookKind;
  /** PR number when the command named one positionally. */
  number?: number;
}

/**
 * Matched anywhere in the command, so `cd x && git push` and `git push && echo`
 * both count. A trailing `<n>` is only read when it sits directly after the
 * subcommand; flags are never parsed as numbers.
 */
const PATTERNS: readonly { kind: HookKind; re: RegExp }[] = [
  { kind: "pr-create", re: /\bgh\s+pr\s+create\b/ },
  { kind: "pr-merge", re: /\bgh\s+pr\s+merge(?:\s+(\d+)\b)?/ },
  { kind: "pr-ready", re: /\bgh\s+pr\s+ready(?:\s+(\d+)\b)?/ },
  { kind: "pr-comment", re: /\bgh\s+pr\s+comment(?:\s+(\d+)\b)?/ },
  { kind: "pr-reply", re: /\bgh\s+api\s+repos\/[^ ]+\/pulls\/(\d+)\// },
  { kind: "eas", re: /\beas\s+(?:update|build)\b/ },
  { kind: "push", re: /\bgit\s+(?:-C\s+\S+\s+)*push\b/ },
];

/** What this command means for the pipeline, or `undefined` if nothing. */
export function decide(command: string): Decision | undefined {
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(command);
    if (!m) continue;
    const n = m[1];
    return n === undefined ? { kind } : { kind, number: Number(n) };
  }
  return undefined;
}

/** The directory a command explicitly targets: `git -C <path>` or `cd <path> &&`. */
export function commandCwd(command: string): string | undefined {
  const quoted = String.raw`(?:"([^"]+)"|'([^']+)'|(\S+))`;
  const m =
    new RegExp(String.raw`\bgit\s+-C\s+${quoted}`).exec(command) ??
    new RegExp(String.raw`^\s*cd\s+${quoted}\s*&&`).exec(command);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

// ---------- run ----------

export interface HookInput {
  cwd?: string;
  /** "PostToolUse" | "SessionStart" | … — absent in older payloads. */
  hook_event_name?: string;
  /** SessionStart only: "startup" | "resume" | "clear" | "compact". */
  source?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

export interface HookDeps {
  db: Db;
  cfg: Config;
  sync: (repos: RepoKey[]) => Promise<SyncResult[]>;
  currentBranch: (cwd: string) => string | undefined;
  repoForCwd: (cwd: string, cfg: Config) => RepoConfig | undefined;
  /** Overridable so tests do not wait 40 s. */
  timeoutMs?: number;
}

/** The stdout line for this event, or `undefined` when there is nothing to add. */
export async function runHook(input: HookInput, deps: HookDeps): Promise<string | undefined> {
  if (input.hook_event_name === "SessionStart") return runSessionStart(input, deps);
  if (input.tool_name !== "Bash") return undefined;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return undefined;
  const decision = decide(command);
  if (!decision) return undefined;

  const cwd = input.cwd ?? process.cwd();
  const named = commandCwd(command);
  const repo =
    (named === undefined ? undefined : deps.repoForCwd(resolve(cwd, named), deps.cfg)) ??
    deps.repoForCwd(cwd, deps.cfg);
  if (!repo) return undefined;
  const key = repoKey(repo);

  const results = await raceTimeout(deps.sync([key]), deps.timeoutMs ?? TIMEOUT_MS);
  if (!results) {
    const msg = `Shipboard: sync of ${repoLabel(key)} timed out; call shipboard_sync in a moment.`;
    return output("PostToolUse", msg);
  }
  const synced = results.find((r) => r.repo === key);

  const branch = decision.number === undefined ? deps.currentBranch(cwd) : undefined;
  const found =
    decision.number === undefined
      ? branch === undefined
        ? undefined
        : lookupBranch(deps.db, deps.cfg, key, branch)
      : lookupPr(deps.db, deps.cfg, key, decision.number);

  const lines = found
    ? describe(found, key, deps.cfg)
    : decision.kind === "pr-create"
      ? [`Shipboard: sync ran but found no PR for branch ${branch ?? "HEAD"} yet; call shipboard_sync in a moment.`]
      : decision.kind === "push" && branch !== undefined
        ? needsPrLines(deps, repo, branch)
        : [];
  if (lines.length === 0) return undefined;

  lines.push(...alsoLines(synced?.changes ?? [], key, found?.pr.pr.number));
  const error = synced?.errors[0];
  if (error !== undefined) lines.push(`  (sync: ${error})`);
  return output("PostToolUse", lines.slice(0, MAX_LINES).join("\n"));
}

type Found = { pr: PrView; item: ItemView | undefined };

/** `lookupBranch`, but selecting the PR by number. */
function lookupPr(db: Db, cfg: Config, repo: RepoKey, number: number): Found | undefined {
  const pr = store.findPr(db, repo, number);
  if (!pr) return undefined;
  const item = pr.item_id === null ? undefined : store.getItem(db, pr.item_id);
  return { pr: viewPr(pr, cfg), item: item ? viewItem(db, cfg, item) : undefined };
}

/**
 * A push on a branch with no PR. Silence is right while the work is still
 * local; once the branch is on origin with commits ahead of dev, the missing
 * PR is the only thing standing between it and the pipeline.
 */
function needsPrLines(deps: HookDeps, repo: RepoConfig, branch: string): string[] {
  const wt = store.findWorktree(deps.db, repoKey(repo), branch);
  if (!wt || worktreeStage(wt, undefined) !== "needs-pr") return [];
  return [
    `Shipboard: ${branch} is pushed but has no PR (${plural(wt.ahead_of_dev, "commit")} ahead of ` +
      `${repo.dev_branch}). Open one with gh pr create, then shipboard_link_pr.`,
  ];
}

function describe(found: Found, repo: RepoKey, cfg: Config): string[] {
  const { pr, item } = found;
  if (!item) {
    // The open dev→prod PR is the release train, not a piece of work.
    if (isReleasePr(pr.pr, cfg)) return [];
    return [
      `Shipboard: no work item tracks ${prLabel(pr)} (${pr.pr.head_branch}). ` +
        `Call shipboard_upsert_item with a title, one-paragraph summary and a change list, then ` +
        `shipboard_link_pr {item_id, repo: "${repo}", number: ${pr.pr.number}}. ` +
        `If it belongs to an existing item, shipboard_list first.`,
    ];
  }
  const lines = [
    `Shipboard: item #${item.item.id} "${clip(item.item.title)}" is now ${item.stage} (${prDetail(pr)}).`,
  ];
  for (const w of item.warnings.slice(0, 2)) lines.push(`  ! ${w}`);
  const hint = hintFor(item);
  if (hint) lines.push(`  → ${hint}`);
  return lines;
}

// ---------- SessionStart digest ----------

/**
 * The attention queue for the project owning `cwd`, or `undefined` when the cwd
 * belongs to no configured repo (that is how the digest stays opt-in per
 * project), or no action is pending and all sources are healthy. Never syncs:
 * startup uses cached actions with project-scoped source health.
 */
export function runSessionStart(input: HookInput, deps: HookDeps): string | undefined {
  const repo = deps.repoForCwd(input.cwd ?? process.cwd(), deps.cfg);
  if (!repo) return undefined;
  const project = projectForRepo(deps.cfg, repoKey(repo));
  if (project === undefined) return undefined;

  const sections = collect(deps.db, deps.cfg, { project, attention: true });
  const actions = nextActions(sections);
  const paths = new Set(actions.flatMap((a) => a.path ? [a.path] : []));
  const forgotten = sections.worktrees.untracked.filter((v) => paths.has(v.wt.path));
  const total = sections.items.length + sections.unlinked.length + forgotten.length;
  const health = readSyncHealth(deps.db, deps.cfg, { project });
  const healthPriority = { failed: 0, stale: 1, never: 2, healthy: 3 };
  const unhealthy = health.filter((source) => source.status !== "healthy")
    .sort((a, b) => healthPriority[a.status] - healthPriority[b.status]);
  if (total === 0 && unhealthy.length === 0) return undefined;

  // Oldest source success describes the whole project's coverage; one recent
  // PR must not imply that other repositories or sources are current.
  const oldest = health.map((source) => source.last_success_at).filter((at): at is string => at !== null).sort()[0];
  const freshness = unhealthy.length
    ? ` (source health: ${unhealthy.slice(0, 3).map((source) => `${repoLabel(source.repo)}/${source.source} ${source.status === "never" ? "never synced" : source.status}`).join("; ")}${unhealthy.length > 3 ? `; +${unhealthy.length - 3} more` : ""})`
    : oldest ? ` (synced ${relTime(oldest)})` : "";
  const head = total === 0
    ? `Shipboard (${project}): no actions in cached data — check source health with shipboard_list.${freshness}`
    : `Shipboard (${project}): ${plural(total, "item")} ${total === 1 ? "needs" : "need"} attention — ` +
      `run shipboard_list {attention:true} for detail.${freshness}`;

  const body = [...forgottenLine(forgotten), ...digestBody(sections)];
  const room = MAX_DIGEST_LINES - 1;
  const shown =
    body.length <= room
      ? body
      : [...body.slice(0, room - 1), `  …and ${body.length - (room - 1)} more`];
  return output("SessionStart", [head, ...shown].join("\n"));
}

/**
 * "  forgotten: sample-feature (API 2 unpushed, 1d ago) · usage-reports (API 1 unpushed, 3d ago)"
 * — one line for all of it, so the digest still fits in ten.
 */
function forgottenLine(views: WorktreeView[]): string[] {
  if (views.length === 0) return [];
  const silos = [...groupBySilo(views)].map(([silo, list]) => {
    const parts = list.map(
      (v) => `${repoLabel(v.wt.repo)} ${localState(v)}${v.wt.last_commit_at ? `, ${relTime(v.wt.last_commit_at)}` : ""}`,
    );
    return `${silo} (${parts.join("; ")})`;
  });
  return [`  forgotten: ${silos.join(" · ")}`];
}

/** One line per item, highest action priority first, then untracked PRs. */
function digestBody(sections: LsSections): string[] {
  const items = [...sections.items].sort((a, b) =>
    (itemActions(b)[0]?.priority ?? 0) - (itemActions(a)[0]?.priority ?? 0),
  );
  const lines: string[] = [];
  table(items.map((v) => [`#${v.item.id} ${actionStages(v)}`, clip(v.item.title, 50), attentionPrs(v)])).forEach(
    (line, i) => {
      lines.push(`  ${line}`);
      for (const w of items[i]?.warnings ?? []) lines.push(`    ! ${w}`);
    },
  );
  for (const v of sections.unlinked) {
    const n = v.pr.unresolved_bot_threads;
    const kinds = [...new Set(prActions(v).map((a) => a.kind))].join(" + ") || v.stage;
    lines.push(`  untracked: ${prLabel(v)} ${kinds}${n > 0 ? `(${n})` : ""}`);
  }
  return lines;
}

/** Show independent problems alongside lifecycle state without repeating warnings. */
function actionStages(v: ItemView): string {
  const extra = itemActions(v).map((a) => a.kind).filter((kind) =>
    kind !== v.stage && !(kind === "merge-prerequisite" && v.warnings.length > 0),
  );
  return [v.stage, ...new Set(extra)].join(" + ");
}

function localState(v: WorktreeView): string {
  if (v.stage === "unknown") return "local state unknown";
  if (v.stage === "needs-pr") return `${v.wt.ahead_of_dev} ahead, needs PR`;
  const parts = [v.wt.dirty === 1 ? "uncommitted changes" : "",
    v.wt.unpushed > 0 ? `${v.wt.unpushed} unpushed` : "",
    v.wt.unpushed < 0 || v.wt.ahead_of_dev < 0 ? "commit counts unknown" : ""].filter(Boolean);
  return parts.join(", ") || "local changes";
}

/** "API#268 (2 threads) · mobile#3 (1 thread)" — the PRs holding the item here. */
function attentionPrs(v: ItemView): string {
  if (v.stage === "blocked") return clip(v.item.blocked_reason ?? "", 50);
  const driving = v.prs.filter((p) => p.stage === v.stage || prActions(p).some((a) => a.actor === "agent"));
  const shown = driving.length > 0 ? driving : v.prs.filter((p) => p.stage !== "closed");
  const prs = shown.map((p) =>
    // Thread counts only matter while the PR is still open.
    p.pr.state !== "OPEN" || p.pr.unresolved_bot_threads === 0
      ? prLabel(p)
      : `${prLabel(p)} (${plural(p.pr.unresolved_bot_threads, "thread")})`,
  );
  // A branch with no PR is the whole story for a local-only item.
  const wts = localWorktrees(v.worktrees).map(
    (w) => `${repoLabel(w.wt.repo)}⎇${w.wt.branch} ${w.stage}(${localState(w)})`,
  );
  return [...prs, ...wts].join(" · ");
}

// ---------- strings ----------

function clip(s: string, max = 70): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function prLabel(v: PrView): string {
  return `${repoLabel(v.pr.repo)}#${v.pr.number}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "API#205 round 3, 4 unresolved bot threads, CI ✓" */
function prDetail(v: PrView): string {
  const pr = v.pr;
  const parts: string[] = [];
  if (pr.state === "MERGED") parts.push("merged");
  else if (pr.state === "CLOSED") parts.push("closed");
  else {
    if (pr.review_round > 0) parts.push(`round ${pr.review_round}`);
    if (pr.unresolved_bot_threads > 0) parts.push(plural(pr.unresolved_bot_threads, "unresolved bot thread"));
    const ci = ciGlyph(pr.ci_state);
    if (ci) parts.push(`CI ${ci}`);
  }
  return parts.length === 0 ? prLabel(v) : `${prLabel(v)} ${parts.join(", ")}`;
}

/** One short line naming whoever has to act next. */
function hintFor(v: ItemView): string | undefined {
  if (v.actor === null) return undefined;
  switch (v.stage) {
    case "needs-addressing":
      return "agent should address the threads";
    case "ci-failing":
      return "agent should fix the failing CI";
    case "ready-to-merge":
      return "waiting for you: ready to merge";
    case "needs-testing":
      return "waiting for you: test it on dev then `shipboard task done`";
    case "needs-release":
      return "waiting for you: open the release PR";
    case "needs-prod-deploy":
      return `waiting for you: deploy to prod then \`shipboard deployed ${v.item.id} prod\``;
    case "needs-post-deploy":
      return "waiting for you: post-deploy tasks are still open";
    case "blocked":
      return `waiting for you: blocked — ${clip(v.item.blocked_reason ?? "", 50)}`;
    default:
      return undefined;
  }
}

/** Fields worth mentioning for the *other* PRs this sync touched. */
const NOTABLE = new Set(["state", "review_round", "unresolved_bot_threads", "ci_state"]);

function alsoLines(changes: PrChange[], repo: RepoKey, skip: number | undefined): string[] {
  const byPr = new Map<number, Map<string, PrChange>>();
  for (const c of changes) {
    if (c.repo !== repo || c.number === skip || !NOTABLE.has(c.field)) continue;
    let fields = byPr.get(c.number);
    if (!fields) byPr.set(c.number, (fields = new Map()));
    fields.set(c.field, c);
  }

  const lines: string[] = [];
  for (const [number, fields] of byPr) {
    const parts: string[] = [];
    const state = fields.get("state");
    if (state) parts.push(state.to === "MERGED" ? "merged" : state.to === "CLOSED" ? "closed" : "reopened");
    const round = fields.get("review_round");
    if (round && Number(round.to) > Number(round.from)) parts.push(`review round ${String(round.to)} landed`);
    const threads = fields.get("unresolved_bot_threads");
    if (threads) parts.push(`${String(threads.to)} unresolved`);
    const ci = fields.get("ci_state");
    if (ci && typeof ci.to === "string") parts.push(`CI ${ciGlyph(ci.to as CiState) || ci.to.toLowerCase()}`);
    if (parts.length > 0) lines.push(`  also: ${repoLabel(repo)}#${number} ${parts.join(", ")}`);
  }
  return lines.slice(0, 3);
}

type HookEventName = "PostToolUse" | "SessionStart";

function output(hookEventName: HookEventName, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// ---------- I/O ----------

/** Resolves `undefined` if `p` has not settled within `ms`. `p` may stay pending. */
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((res) => {
    timer = setTimeout(() => res(undefined), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function gitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" || out === "HEAD" ? undefined : out;
  } catch {
    return undefined;
  }
}

function debug(err: unknown): void {
  if (!process.env["SHIPBOARD_HOOK_DEBUG"]) return;
  process.stderr.write(`shipboard-hook: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<string | undefined> {
  const input = JSON.parse(await readStdin()) as HookInput;
  const cfg = loadConfig();
  const db = openDb();
  return runHook(input, {
    db,
    cfg,
    sync: (repos) => syncAll(db, cfg, { repos }),
    currentBranch: gitBranch,
    repoForCwd,
  });
}

// Exit explicitly: a timed-out sync may still hold the event loop open.
// realpath so a symlinked bin (npm link) still counts as direct invocation.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(resolve(entry)) === fileURLToPath(import.meta.url)) {
  main()
    .catch((err: unknown) => {
      debug(err);
      return undefined;
    })
    .then((out) => {
      if (out === undefined) process.exit(0);
      process.stdout.write(`${out}\n`, () => process.exit(0));
    });
}

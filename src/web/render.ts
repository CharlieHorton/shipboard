/**
 * Server-side HTML for the dashboard. Pure functions: data in, HTML string out.
 * The server (src/server.ts) owns routing; this file owns markup, CSS and the
 * little client-side JS.
 */
import { ciGlyph, linearUrl, relTime, repoLabel, tildePath } from "../format.js";
import { parseJsonArray } from "../store.js";
import { itemActions, nextActions, prActions, type NextAction } from "../actions.js";
import { captureEvidence, evidenceMatches, manualDeployCoversCurrentPrs } from "../evidence.js";
import type { SyncHealthView } from "../sync-health.js";
import type {
  Actor,
  EventRow,
  ItemStage,
  PrRow,
  PrStage,
  TaskRow,
  WorktreeStage,
} from "../types.js";
import {
  ATTENTION_PR_STAGES,
  groupBySilo,
  localWorktrees,
  worktreeCount,
  worktreeRemoveCommand,
  type ItemView,
  type LsSections,
  type PrView,
  type ReleaseView,
  type WorktreeView,
} from "../views.js";
import { CLIENT_JS } from "./client.js";
import { CSS } from "./styles.js";
import { SHIPBOARD_ICON } from "./brand.js";

export interface PageOptions {
  /** Currently selected project filter, if any. */
  project?: string | undefined;
  /** All configured project names, for the filter control. */
  projects: string[];
  /** Most recent prs.synced_at across the store, ISO, or undefined if never synced. */
  syncedAt?: string | undefined;
  /** cfg.linear_workspace. Without it, Linear keys render as plain text. */
  linearWorkspace?: string | undefined;
  health?: SyncHealthView[];
  worktreeToken?: string;
}

/** Everything renderDrawer needs beyond the item itself. */
export interface DrawerOptions {
  linearWorkspace?: string | undefined;
}

// ---------- kanban layout ----------

/**
 * The board's columns, left to right. Every ITEM_STAGES value belongs to
 * exactly one column except `blocked`: a blocked item's real position depends
 * on PR state the view layer cannot recompute, so blocked items are shown in
 * BLOCKED_COLUMN with a red `blocked` badge rather than guessing.
 */
export const KANBAN_COLUMNS: { title: string; stages: ItemStage[] }[] = [
  { title: "Local", stages: ["local-only", "needs-pr"] },
  { title: "Drafting", stages: ["drafting"] },
  {
    title: "In review",
    stages: ["awaiting-review", "awaiting-re-review", "needs-addressing", "ci-failing", "awaiting-ci"],
  },
  { title: "Ready to merge", stages: ["ready-to-merge"] },
  { title: "In develop", stages: ["merged-develop", "needs-testing", "tested", "needs-release"] },
  { title: "In release", stages: ["in-release"] },
  { title: "On main", stages: ["merged-main", "needs-prod-deploy"] },
  { title: "Post-deploy", stages: ["needs-post-deploy"] },
  { title: "Done", stages: ["done"] },
];

const BLOCKED_COLUMN = "In review";

// ---------- escaping and small pieces ----------

/** HTML-escape text content and attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** `text` must already be escaped. Non-http(s) URLs lose their link. */
function link(url: string, text: string): string {
  if (!/^https?:\/\//i.test(url)) return text;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${text}</a>`;
}

/** The issue's Linear URL, or undefined when the workspace or the key is missing. */
function issueUrl(key: string | null, ws: string | undefined): string | undefined {
  return ws === undefined ? undefined : linearUrl({ linear_workspace: ws }, key);
}

/** "PROP-42" as a link when we know the workspace, otherwise as plain text. */
function linearText(key: string, ws: string | undefined): string {
  return link(issueUrl(key, ws) ?? "", escapeHtml(key));
}

/** The same, as a chip for cards and attention rows. Empty when there is no key. */
function linearChip(key: string | null, ws: string | undefined): string {
  if (!key) return "";
  const url = issueUrl(key, ws);
  const text = escapeHtml(key);
  return url === undefined
    ? `<span class="chip">${text}</span>`
    : `<a class="chip" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${text}</a>`;
}

const STAGE_FAMILY: Record<ItemStage | PrStage | WorktreeStage, string> = {
  "local-only": "s-agent",
  "needs-pr": "s-human",
  // Worktree-only stages: nothing to act on, so they stay grey.
  "has-pr": "s-wait",
  empty: "s-wait",
  merged: "s-wait",
  unknown: "s-blocked",
  drafting: "s-wait",
  "awaiting-review": "s-wait",
  "awaiting-re-review": "s-wait",
  "awaiting-ci": "s-wait",
  closed: "s-wait",
  "needs-addressing": "s-agent",
  "ci-failing": "s-agent",
  "ready-to-merge": "s-human",
  "needs-testing": "s-human",
  "needs-release": "s-human",
  "needs-prod-deploy": "s-human",
  "needs-post-deploy": "s-human",
  "merged-develop": "s-merged",
  "in-release": "s-merged",
  "merged-main": "s-merged",
  tested: "s-merged",
  done: "s-done",
  blocked: "s-blocked",
};

function badge(stage: ItemStage | PrStage | WorktreeStage): string {
  return `<span class="badge ${STAGE_FAMILY[stage]}">${escapeHtml(stage)}</span>`;
}

/** "2 unpushed" for local work, "3 ahead" once it is on origin. */
function wtCount(v: WorktreeView): string {
  const n = worktreeCount(v);
  const count = n < 0 ? "commit count unknown" : v.stage === "local-only" ? `${n} unpushed` : `${n} ahead`;
  return v.wt.dirty === 1 ? `uncommitted changes · ${count}` : count;
}

/** "API ⎇ feature/sample-feature" */
function wtRef(v: WorktreeView): string {
  return escapeHtml(`${repoLabel(v.wt.repo)} ⎇ ${v.wt.branch}`);
}

function actorChip(actor: Actor | null): string {
  const text = actor === "agent" ? "agent" : actor === "human" ? "you" : "–";
  return `<span class="chip">${text}</span>`;
}

/** "API#205" */
function prRef(pr: PrRow): string {
  return escapeHtml(`${repoLabel(pr.repo)}#${pr.number}`);
}

/** "(4)" while the PR is open and bots are still waiting on an answer. */
function threads(pr: PrRow): string {
  return pr.state === "OPEN" && pr.unresolved_bot_threads > 0 ? ` (${pr.unresolved_bot_threads})` : "";
}

function warnings(list: readonly string[]): string {
  return list.map((w) => `<div class="warn">! ${escapeHtml(w)}</div>`).join("");
}

function branches(pr: PrRow): string {
  return escapeHtml(`${pr.head_branch} → ${pr.base_branch}`);
}

// ---------- header ----------

function renderHeader(opts: PageOptions): string {
  const options = ["", ...opts.projects]
    .map((p) => {
      const selected = (p === "" ? !opts.project : p === opts.project) ? " selected" : "";
      const label = p === "" ? "All projects" : escapeHtml(p);
      return `<option value="${escapeHtml(p)}"${selected}>${label}</option>`;
    })
    .join("");
  const unhealthy = opts.health?.filter((h) => h.status !== "healthy").length ?? 0;
  const synced = opts.health?.length ? (unhealthy ? `${unhealthy} sources need checking` : "All sources fresh")
    : opts.syncedAt ? `synced ${relTime(opts.syncedAt)}` : "never synced";
  return `<header class="top">
<a class="brand" href="/" aria-label="Shipboard home"><span class="brand-icon" aria-hidden="true">${SHIPBOARD_ICON}</span><span class="wordmark">Shipboard<small>YOUR SHIPPING DESK</small></span></a>
<nav aria-label="Dashboard"><a href="#attention">Attention</a><a href="#board">Pipeline</a></nav>
<span class="spacer"></span>
<select id="project-filter" aria-label="Project filter">${options}</select>
<span class="muted${unhealthy ? " needs-checking" : ""}" id="synced">${escapeHtml(synced)}</span>
<button id="sync-btn" type="button">Sync</button>
</header>`;
}

// ---------- attention queue ----------

/** The PRs that put the item in its stage; everything live if none match. */
function drivingPrs(v: ItemView): PrView[] {
  const driving = v.prs.filter((p) => p.stage === v.stage);
  return driving.length > 0 ? driving : v.prs.filter((p) => p.stage !== "closed");
}

function attentionRow(v: ItemView, ws: string | undefined, actor?: Actor): string {
  const prs = drivingPrs(v)
    .map((p) => `${prRef(p.pr)}${threads(p.pr)}`)
    .join(" · ");
  const reason =
    v.stage === "blocked" && v.item.blocked_reason
      ? `<div class="reason">${escapeHtml(v.item.blocked_reason)}</div>`
      : "";
  return `<li class="row" data-item="${v.item.id}" tabindex="0">
<div class="line"><span class="id">#${v.item.id}</span>${badge(v.stage)}<span class="title">${escapeHtml(
    v.item.title,
  )}</span>${linearChip(v.item.linear_key, ws)}<span class="prs">${prs}</span></div>
${warnings(v.warnings)}${reason}<ul class="action-reasons">${itemActions(v).filter((a) => !actor || a.actor === actor).map((a) => `<li>${escapeHtml(a.title)} — ${escapeHtml(a.reason)}</li>`).join("")}</ul></li>`;
}

function attentionGroup(title: string, views: ItemView[], ws: string | undefined): string {
  if (views.length === 0) return "";
  const rows = views.map((v) => attentionRow(v, ws, title === "Agent can act" ? "agent" : "human")).join("");
  return `<h3>${escapeHtml(title)}</h3><ul class="rows">${rows}</ul>`;
}

function untrackedAttention(views: PrView[]): string {
  if (views.length === 0) return "";
  const rows = views
    .map(
      (v) =>
        `<li>${link(v.pr.url, prRef(v.pr))} ${badge(v.stage)}${escapeHtml(threads(v.pr))} <span class="muted">${escapeHtml(
          v.pr.title,
        )}</span><div class="reason">${escapeHtml(prActions(v).map((a) => a.title).join(" · "))}</div></li>`,
    )
    .join("");
  return `<h3>Untracked PRs needing action</h3><ul class="lines">${rows}</ul>`;
}

/**
 * Local commits no item tracks. Not clickable: there is nothing to open yet,
 * so the group carries the one command that turns a silo into an item.
 */
function forgottenWork(views: WorktreeView[]): string {
  if (views.length === 0) return "";
  const rows = [...groupBySilo(views)]
    .flatMap(([silo, list]) =>
      list.map(
        (v) =>
          `<li class="wt-row"><span class="silo">${escapeHtml(silo)}</span> <span class="mono">${wtRef(
            v,
          )}</span> <span class="muted">· ${escapeHtml(wtCount(v))} · ${escapeHtml(
            relTime(v.wt.last_commit_at),
          )}</span></li>`,
      ),
    )
    .join("");
  return `<h3>Forgotten local work</h3><ul class="lines">${rows}</ul>
<p class="muted">Create item: <code>shipboard item add --title "…" --silo &lt;silo&gt;</code></p>`;
}

function renderAttention(sections: LsSections, ws: string | undefined): string {
  const agent = sections.items.filter((v) => itemActions(v).some((a) => a.actor === "agent"));
  const human = sections.items.filter((v) => itemActions(v).some((a) => a.actor === "human"));
  const prs = sections.unlinked.filter((v) => prActions(v).length > 0);
  const forgotten = sections.worktrees.untracked;
  const body =
    agent.length + human.length + prs.length + forgotten.length === 0
      ? `<p class="muted">Nothing needs attention.</p>`
      : attentionGroup("Agent can act", agent, ws) +
        attentionGroup("Needs you", human, ws) +
        forgottenWork(forgotten) +
        untrackedAttention(prs);
  return `<section id="attention"><h2>Attention queue</h2>${body}</section>`;
}

function renderNext(sections: LsSections): string {
  const actions = nextActions(sections).slice(0, 3);
  if (!actions.length) return "";
  return `<section id="next"><h2>Your next three moves</h2>
<p class="muted section-note">Start here. Prioritized from your latest local, CI, review, and merge observations.</p>
<ol class="next-moves">${actions.map((a: NextAction) => {
    const item = sections.items.find((v) => v.item.id === a.item_id);
    const label = escapeHtml(a.title);
    const title = a.item_id ? `<button type="button" data-item="${a.item_id}">${label}</button>` : a.url ? link(a.url, label) : label;
    return `<li>${actorChip(a.actor)} ${title}${item ? `<div class="muted">${escapeHtml(item.item.project)} · ${escapeHtml(item.item.title)}</div>` : ""}<p>${escapeHtml(a.reason)}</p>${a.path ? `<code>${escapeHtml(tildePath(a.path))}</code>` : ""}</li>`;
  }).join("")}</ol></section>`;
}

function renderHealth(health: SyncHealthView[] | undefined): string {
  if (!health?.length) return "";
  const unhealthy = health.filter((h) => h.status !== "healthy").length;
  return `<details id="sync-health"${unhealthy ? " open" : ""}><summary>Source health · ${unhealthy ? `${unhealthy} need checking` : "all fresh"}</summary>
<ul class="lines">${health.map((h) => `<li><strong>${escapeHtml(h.repo)}</strong> · ${escapeHtml(h.source)} · <span class="${h.status === "healthy" ? "muted" : "warn"}">${escapeHtml(h.status)}</span> · last success ${h.last_success_at ? escapeHtml(relTime(h.last_success_at)) : "never"}${h.errors.length ? `<div class="reason">${escapeHtml(h.errors.join("; "))}</div>` : ""}</li>`).join("")}</ul></details>`;
}

// ---------- board ----------

function cardPrLine(p: PrView): string {
  const ci = ciGlyph(p.pr.ci_state);
  return `<div class="pr">${prRef(p.pr)} ${escapeHtml(p.stage)}${escapeHtml(threads(p.pr))}${
    ci ? ` ${ci}` : ""
  }</div>`;
}

/** "API ⎇ feature/sample-feature local-only (2 unpushed)" — a branch with no PR. */
function cardWorktreeLine(v: WorktreeView): string {
  return `<div class="pr wt">${wtRef(v)} ${escapeHtml(v.stage)} (${escapeHtml(wtCount(v))})</div>`;
}

function card(v: ItemView, ws: string | undefined): string {
  const prs = v.prs
    .filter((p) => p.stage !== "closed")
    .map(cardPrLine)
    .join("");
  const wts = localWorktrees(v.worktrees).map(cardWorktreeLine).join("");
  return `<article class="card" data-item="${v.item.id}" tabindex="0">
<span class="id">#${v.item.id}</span> <span class="title">${escapeHtml(v.item.title)}</span>
<div>${badge(v.stage)} ${actorChip(v.actor)} ${linearChip(v.item.linear_key, ws)}</div>
${prs}${wts}${warnings(v.warnings)}</article>`;
}

function renderBoard(items: ItemView[], ws: string | undefined): string {
  const columns = KANBAN_COLUMNS.map((col) => {
    const inCol = items.filter(
      (v) => col.stages.includes(v.stage) || (col.title === BLOCKED_COLUMN && v.stage === "blocked"),
    );
    return `<div class="col${inCol.length === 0 ? " empty" : ""}">
<div class="col-head"><h3>${escapeHtml(col.title)}</h3><span class="count">${inCol.length}</span></div>
${inCol.map((v) => card(v, ws)).join("")}${inCol.length === 0 ? '<span class="empty-lane" aria-hidden="true">—</span>' : ""}</div>`;
  }).join("");
  return `<section id="board"><div class="section-heading"><h2>Board</h2><span class="muted">From first commit to shipped.</span></div><div class="board" tabindex="0" role="region" aria-label="Delivery pipeline, scroll horizontally for all stages">${columns}</div></section>`;
}

// ---------- below the board ----------

function renderRelease(entries: ReleaseView[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map(
      (e) =>
        `<li>${link(e.view.pr.url, prRef(e.view.pr))} <span class="mono">${branches(
          e.view.pr,
        )}</span> · ${badge(e.view.stage)} · <span class="muted">contains ${e.contains} PR${
          e.contains === 1 ? "" : "s"
        }</span></li>`,
    )
    .join("");
  return `<section id="release"><h2>Release PRs</h2><ul class="lines">${rows}</ul></section>`;
}

/** Worktrees with nothing left ahead of dev: safe to delete, with the command. */
/** Every worktree no item tracks, grouped by silo: pushed-without-PR as well as local-only. */
function renderUntrackedWorktrees(views: WorktreeView[]): string {
  if (views.length === 0) return "";
  const rows = [...groupBySilo(views)]
    .map(([silo, group]) => {
      const cells = group
        .map(
          (v) =>
            `${wtRef(v)} ${badge(v.stage)} <span class="muted">${escapeHtml(wtCount(v))} · ${escapeHtml(
              relTime(v.wt.last_commit_at),
            )}</span>`,
        )
        .join(" · ");
      return `<li><strong>${escapeHtml(silo)}</strong> ${cells}</li>`;
    })
    .join("");
  return `<section id="untracked-worktrees"><h2>Untracked worktrees</h2><ul class="lines">${rows}</ul></section>`;
}

function renderHousekeeping(views: WorktreeView[]): string {
  if (views.length === 0) return "";
  const rows = views
    .map((v) => {
      const path = tildePath(v.wt.path);
      const state = v.pr ? `${v.stage} (PR #${v.pr.number})` : v.stage;
      const command = worktreeRemoveCommand(v);
      return `<tr><td>${escapeHtml(repoLabel(v.wt.repo))}</td><td class="mono">${escapeHtml(
        path,
      )}</td><td>${escapeHtml(state)}</td><td><code>${escapeHtml(
        command ?? "Removal command unavailable: verify the owning checkout and local state",
      )}</code>${command ? ` <button type="button" class="danger" data-worktree-remove="${escapeHtml(v.wt.path)}" data-worktree-head="${escapeHtml(v.wt.head_sha)}">Remove worktree</button>` : ""}</td></tr>`;
    })
    .join("");
  return `<section id="housekeeping"><h2>Worktrees to clean up</h2>
<p class="muted">Candidates from the last scan. Remove worktree checks local state again and asks for confirmation. The checkout folder, including ignored files, is deleted; the branch is kept.</p>
<table class="wt-table"><thead><tr><th>Repo</th><th>Path</th><th>State</th><th>Remove</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderUnlinked(views: PrView[]): string {
  if (views.length === 0) return "";
  const rows = views
    .map((v) => {
      const n = v.pr.unresolved_bot_threads > 0 ? `(${v.pr.unresolved_bot_threads})` : "";
      const ci = ciGlyph(v.pr.ci_state) || "-";
      return `<li>${link(v.pr.url, prRef(v.pr))} <span class="mono">${branches(v.pr)}</span> ${badge(
        v.stage,
      )}${escapeHtml(n)} <span class="muted">round ${v.pr.review_round} · ci ${escapeHtml(ci)}</span></li>`;
    })
    .join("");
  return `<section id="unlinked"><h2>Untracked open PRs</h2><ul class="lines">${rows}</ul></section>`;
}

// ---------- page ----------

/** The full dashboard document for GET /. */
export function renderPage(sections: LsSections, opts: PageOptions): string {
  const ws = opts.linearWorkspace;
  const active = sections.items.filter((v) => v.stage !== "done").length;
  const human = sections.items.filter((v) => itemActions(v).some((a) => a.actor === "human")).length;
  const agent = sections.items.filter((v) => itemActions(v).some((a) => a.actor === "agent")).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${opts.worktreeToken ? `<meta id="worktree-token" content="${escapeHtml(opts.worktreeToken)}">` : ""}
<title>Shipboard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=1">
<meta name="theme-color" content="#102e38">
<meta name="color-scheme" content="light dark">
<style>${CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to dashboard</a>
${renderHeader(opts)}
<main id="main">
<div class="overview"><div><p class="eyebrow">${escapeHtml(opts.project ?? "All projects")} / OVERVIEW</p><h1>Keep work moving.</h1></div><dl class="metrics" aria-label="Tracked item overview"><div><dt>In flight</dt><dd>${active}</dd></div><div><dt>Need you</dt><dd>${human}</dd></div><div><dt>Agent can act</dt><dd>${agent}</dd></div></dl></div>
<div id="request-error" class="warn" role="alert" hidden></div>
${renderHealth(opts.health)}
${renderNext(sections)}
${renderAttention(sections, ws)}
${renderBoard(sections.items, ws)}
${renderUntrackedWorktrees(sections.worktrees.untracked)}
${renderHousekeeping(sections.worktrees.housekeeping)}
${renderRelease(sections.release)}
${renderUnlinked(sections.unlinked)}
<footer><span>Shipboard <span class="muted">/ A little order. More shipped.</span></span><span class="muted">Auto-refresh · 2 min</span></footer>
</main>
<div id="backdrop" hidden></div>
<aside id="drawer" hidden aria-label="Item detail">
<button id="drawer-close" type="button" data-close aria-label="Close">✕</button>
<div id="drawer-body"></div>
</aside>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}

// ---------- drawer ----------

function tick(on: -1 | 0 | 1): string {
  return on === -1 ? "unknown" : on === 1 ? "✓" : "–";
}

/**
 * "✓ 3d ago" once the PR's merge commit has actually reached users (an EAS OTA
 * group, today); the update that shipped it is the tooltip. Manual deploys stay
 * "–" here — they are asserted per item, not per PR.
 */
function shipped(pr: PrRow): string {
  if (!pr.deployed_at) return "–";
  const when = `✓ ${escapeHtml(relTime(pr.deployed_at))}`;
  return pr.deploy_ref === null ? when : `<span title="${escapeHtml(pr.deploy_ref)}">${when}</span>`;
}

function drawerPrs(view: ItemView): string {
  if (view.prs.length === 0) return `<p class="muted">No PRs linked.</p>`;
  const rows = view.prs
    .map((p) => {
      const text = `${prRef(p.pr)} <span class="mono">${branches(p.pr)}</span>`;
      const release = p.pr.in_release_pr === null ? "" : `release #${p.pr.in_release_pr}`;
      return `<tr><td>${link(p.pr.url, text)}</td><td>${badge(p.stage)}</td><td>round ${
        p.pr.review_round
      }</td><td>${p.pr.unresolved_bot_threads}</td><td>${ciGlyph(p.pr.ci_state) || "-"}</td><td>dev ${tick(
        p.pr.on_dev,
      )}</td><td>${tick(p.pr.on_prod)}</td><td>${shipped(p.pr)}</td><td class="muted">${escapeHtml(
        release,
      )}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>PR</th><th>Stage</th><th>Round</th><th>Threads</th><th>CI</th><th>Dev</th><th title="Commit is on the production branch; deployment is tracked separately">Prod branch</th><th>Shipped</th><th>Release</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Every worktree attached to the item — by a linked PR or by silo. */
function drawerWorktrees(views: WorktreeView[]): string {
  if (views.length === 0) return "";
  const rows = views
    .map(
      (v) =>
        `<tr><td>${escapeHtml(repoLabel(v.wt.repo))}</td><td class="mono">${escapeHtml(
          v.wt.branch,
        )}</td><td>${badge(v.stage)}</td><td>${v.wt.ahead_of_dev < 0 ? "unknown" : v.wt.ahead_of_dev}</td><td>${v.wt.unpushed < 0 ? "unknown" : v.wt.unpushed}</td><td>${tick(
          v.wt.dirty,
        )}</td><td>${escapeHtml(relTime(v.wt.last_commit_at))}</td><td><code>${escapeHtml(
          tildePath(v.wt.path),
        )}</code></td></tr>`,
    )
    .join("");
  return `<h3>Worktrees</h3>
<table class="wt-table"><thead><tr><th>Repo</th><th>Branch</th><th>Stage</th><th>Ahead</th><th>Unpushed</th><th>Dirty</th><th>Last commit</th><th>Path</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function drawerTasks(tasks: TaskRow[], prs: PrRow[]): string {
  if (tasks.length === 0) return `<p class="muted">No tasks.</p>`;
  const rows = tasks
    .map((t) => {
      const done = t.done_at !== null;
      const stale = done && t.kind === "test" && !evidenceMatches(t.completion_evidence, prs);
      const evidence = t.kind === "test" ? ` data-evidence="${escapeHtml(captureEvidence(prs) ?? "")}"` : "";
      const button = !done || stale ? ` <button type="button" data-task-done="${t.id}"${evidence}>${stale ? "Confirm retest" : "Done"}</button>` : "";
      return `<li><span class="box">${done ? "[x]" : "[ ]"}</span> <span class="chip">${escapeHtml(
        t.kind,
      )}</span> ${escapeHtml(t.text)}${stale ? ` <span class="warn">Previous result does not cover current commits</span>` : ""}${button}</li>`;
    })
    .join("");
  return `<ul class="flat">${rows}</ul>`;
}

function drawerEvents(events: EventRow[]): string {
  if (events.length === 0) return `<p class="muted">No events.</p>`;
  const newestFirst = [...events].sort((a, b) => (a.at === b.at ? b.id - a.id : a.at < b.at ? 1 : -1));
  const rows = newestFirst
    .map(
      (e) =>
        `<li><span class="muted">${escapeHtml(relTime(e.at))}</span> <span class="chip">${escapeHtml(
          e.source,
        )}</span> ${escapeHtml(e.text)}</li>`,
    )
    .join("");
  return `<ul class="flat">${rows}</ul>`;
}

/**
 * The item drawer fragment for GET /item/:id (injected into the page by JS).
 * `opts` is optional so a caller with no config to hand still compiles.
 */
export function renderDrawer(
  view: ItemView,
  tasks: TaskRow[],
  events: EventRow[],
  opts: DrawerOptions = {},
): string {
  const it = view.item;
  // Already-escaped fragments: the Linear key may carry a link.
  const meta = [escapeHtml(it.project)];
  if (it.linear_key) meta.push(linearText(it.linear_key, opts.linearWorkspace));
  if (it.prod_deployed_at) meta.push(escapeHtml(`${manualDeployCoversCurrentPrs(it, view.prs.map((p) => p.pr)) ? "prod confirmed" : "previous prod confirmation (does not cover current commits)"} ${relTime(it.prod_deployed_at)}`));
  const reason = it.blocked_reason
    ? `<div class="reason">blocked: ${escapeHtml(it.blocked_reason)}</div>`
    : "";
  const summary = it.summary ? `<p>${escapeHtml(it.summary)}</p>` : "";
  const changes = parseJsonArray(it.changes);
  const changesHtml =
    changes.length === 0
      ? ""
      : `<h3>Changes</h3><ul>${changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`;
  const deployBtn =
    view.stage === "needs-prod-deploy"
      ? `<button type="button" data-deployed="${it.id}" data-evidence="${escapeHtml(captureEvidence(view.prs.map((p) => p.pr)) ?? "")}">Mark deployed to prod</button>`
      : "";

  return `<h2><span class="id">#${it.id}</span> ${escapeHtml(it.title)}</h2>
<div>${badge(view.stage)} ${actorChip(view.actor)}</div>
<div class="muted">${meta.join(" · ")}</div>
${reason}${summary}${changesHtml}
<p><a href="/api/items/${it.id}/resume?format=text" target="_blank" rel="noreferrer">Resume briefing</a> · <a href="/api/items/${it.id}/resume?format=text" download="shipboard-${it.id}-resume.md">Download briefing</a></p>
${it.stage_override ? `<p class="warn">Manual stage override: ${escapeHtml(it.stage_override)}. This does not certify testing or deployment.</p>` : ""}
<h3>Next actions</h3>
<ul>${itemActions(view).map((a) => `<li>${escapeHtml(a.title)} — ${escapeHtml(a.reason)}</li>`).join("") || "<li>No derived action in the cached state.</li>"}</ul>
<h3>Pull requests</h3>
${drawerPrs(view)}${warnings(view.warnings)}
${drawerWorktrees(view.worktrees)}
<h3>Tasks</h3>
${drawerTasks(tasks, view.prs.map((p) => p.pr))}
<h3>Timeline</h3>
${drawerEvents(events)}
<div class="actions">${deployBtn}<button type="button" class="danger" data-archive="${it.id}">Archive</button></div>
`;
}

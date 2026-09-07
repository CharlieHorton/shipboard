/** A portable handoff assembled exclusively from the local cache. No sync or execution. */
import type { Db } from "./db.js";
import type { Config } from "./types.js";
import { itemActions } from "./actions.js";
import { evidenceMatches, manualDeployCoversCurrentPrs, testsPassForCurrentPrs } from "./evidence.js";
import * as store from "./store.js";
import { viewItem } from "./views.js";
import { readSyncHealth } from "./sync-health.js";

export function buildResume(db: Db, cfg: Config, id: number) {
  const item = store.getItem(db, id);
  if (!item) return undefined;
  const view = viewItem(db, cfg, item);
  const prs = view.prs.map((v) => v.pr);
  const tasks = store.tasksForItem(db, id);
  const repos = new Set([...prs.map((p) => p.repo), ...view.worktrees.map((v) => v.wt.repo)]);
  return {
    item_id: id,
    title: item.title,
    project: item.project,
    summary: item.summary,
    changes: store.parseJsonArray(item.changes),
    stage: view.stage,
    stage_override: item.stage_override,
    blocked_reason: item.blocked_reason,
    actions: itemActions(view),
    warnings: view.warnings,
    tests_current: testsPassForCurrentPrs(tasks, prs),
    manual_deploy_current: manualDeployCoversCurrentPrs(item, prs),
    worktrees: view.worktrees.map((v) => ({ path: v.wt.path, branch: v.wt.branch, repo: v.wt.repo,
      stage: v.stage, head_sha: v.wt.head_sha, seen_at: v.wt.seen_at })),
    prs: view.prs.map((v) => ({ repo: v.pr.repo, number: v.pr.number, title: v.pr.title,
      url: v.pr.url, stage: v.stage, head_sha: v.pr.head_sha, merge_sha: v.pr.merge_sha, synced_at: v.pr.synced_at })),
    open_tasks: tasks.filter((t) => !t.done_at || (t.kind === "test" && !evidenceMatches(t.completion_evidence, prs)))
      .map((t) => ({ id: t.id, kind: t.kind, text: t.text, reconfirm: t.done_at !== null })),
    recent_events: store.eventsForItem(db, id, 12),
    health: readSyncHealth(db, cfg).filter((h) => repos.has(h.repo)),
  };
}

export type ResumeBrief = NonNullable<ReturnType<typeof buildResume>>;

export function formatResume(brief: ResumeBrief): string {
  const lines = [
    `# Resume #${brief.item_id}: ${brief.title}`,
    `Project: ${brief.project} | Stage: ${brief.stage}`,
    "Local cached observations only. Check freshness before acting; this briefing does not authorize external actions.",
    "", brief.summary || "No summary recorded.",
  ];
  if (brief.stage_override) lines.push(`Manual stage override: ${brief.stage_override}`);
  if (brief.blocked_reason) lines.push(`Blocker: ${brief.blocked_reason}`);
  if (brief.changes.length) lines.push("", "Changes:", ...brief.changes.map((c) => `- ${c}`));
  lines.push("", "Next actions:", ...brief.actions.map((a) => `- [${a.actor}] ${a.title} — ${a.reason}`));
  if (!brief.actions.length) lines.push("- No derived action in the cached state.");
  if (brief.warnings.length) lines.push("", "Prerequisites:", ...brief.warnings.map((w) => `- ${w}`));
  lines.push("", `Tests cover current linked commits: ${brief.tests_current ? "yes" : "no"}`,
    `Manual deploy confirmation covers current linked commits: ${brief.manual_deploy_current ? "yes" : "no"}`);
  if (brief.worktrees.length) lines.push("", "Workspaces:", ...brief.worktrees.map((w) => `- ${w.repo}: ${w.path}\n  ${w.branch} @ ${w.head_sha} | ${w.stage} | observed ${w.seen_at}`));
  if (brief.prs.length) lines.push("", "Pull requests:", ...brief.prs.map((p) => `- ${p.repo}#${p.number}: ${p.stage}\n  ${p.url}\n  head ${p.head_sha}; merge ${p.merge_sha ?? "not recorded"}; observed ${p.synced_at}`));
  if (brief.open_tasks.length) lines.push("", "Remaining verification and tasks:", ...brief.open_tasks.map((t) => `- Task ${t.id} [${t.kind}] ${t.text}${t.reconfirm ? " (reconfirm for current commits)" : ""}`));
  if (brief.recent_events.length) lines.push("", "Recent recorded context (oldest first):", ...brief.recent_events.map((e) => `- ${e.at} [${e.source}] ${e.text}`));
  if (brief.health.length) lines.push("", "Source freshness:", ...brief.health.map((h) => `- ${h.repo} / ${h.source}: ${h.status}; last success ${h.last_success_at ?? "never"}${h.errors.length ? `; ${h.errors.join("; ")}` : ""}`));
  return lines.join("\n") + "\n";
}

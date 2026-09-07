/** Read-only, explainable next actions. Lifecycle stage never hides a separate problem. */
import { parseJsonArray } from "./store.js";
import { actorFor } from "./stage.js";
import type { Actor, ItemStage } from "./types.js";
import type { ItemView, LsSections, PrView, WorktreeView } from "./views.js";

export interface NextAction {
  id: string;
  item_id: number | null;
  project: string | null;
  actor: Actor;
  kind: string;
  title: string;
  reason: string;
  priority: number;
  url?: string;
  path?: string;
}

const STAGE_ACTIONS: Partial<Record<ItemStage, [string, string, number]>> = {
  "local-only": ["Inspect local work", "Local changes need to be reviewed and preserved.", 100],
  "needs-pr": ["Prepare a pull request", "Pushed work has no active pull request.", 60],
  "needs-addressing": ["Address review feedback", "Review feedback needs attention.", 80],
  "ci-failing": ["Investigate failing CI", "A check is failing.", 90],
  "ready-to-merge": ["Review merge readiness", "Review and CI gates are satisfied in the cached state.", 70],
  "needs-testing": ["Verify the current changes", "Current linked commits need passing test evidence.", 65],
  "needs-release": ["Prepare a release", "Tested work is waiting for a release PR.", 55],
  "needs-prod-deploy": ["Review production deployment", "Current linked commits have no production deployment evidence.", 50],
  "needs-post-deploy": ["Finish post-deploy tasks", "Deployment is recorded, but verification or tasks remain outstanding.", 75],
  blocked: ["Resolve the blocker", "This item is blocked.", 95],
};

function sortActions(actions: NextAction[]): NextAction[] {
  return actions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function worktreeActions(v: WorktreeView): NextAction[] {
  const base = { id: `worktree:${v.wt.path}`, item_id: null, project: null, path: v.wt.path };
  if (v.stage === "unknown") return [{ ...base, actor: "human", kind: "unknown-local-state",
    title: `Check local state: ${v.wt.branch}`, reason: "Local state could not be verified. This checkout is not a cleanup candidate.", priority: 105 }];
  if (v.stage === "local-only") return [{ ...base, actor: "agent", kind: "local-only",
    title: `Inspect local work: ${v.wt.branch}`,
    reason: [v.wt.dirty === 1 ? "Uncommitted changes" : "", v.wt.unpushed > 0 ? `${v.wt.unpushed} unpushed commits` : ""].filter(Boolean).join(" and ") || "Local work needs inspection.", priority: 100 }];
  if (v.stage === "needs-pr") return [{ ...base, actor: "agent", kind: "needs-pr",
    title: `Prepare a PR: ${v.wt.branch}`, reason: "Pushed work has no active pull request.", priority: 60 }];
  return [];
}

export function prActions(v: PrView): NextAction[] {
  const pr = v.pr;
  if (pr.state !== "OPEN") return [];
  const actions: NextAction[] = [];
  const add = (kind: string, title: string, reason: string, actor: Actor, priority: number): void => {
    actions.push({ id: `pr:${pr.repo}#${pr.number}:${kind}`, item_id: null, project: null,
      kind, title: `${title}: ${pr.repo}#${pr.number}`, reason, actor, priority, url: pr.url });
  };
  // CI is independent of draft/review state: waiting on a bot must not hide a failure.
  if (pr.ci_state === "FAILURE" || pr.ci_state === "ERROR")
    add("ci-failing", "Investigate failing CI", `CI reports ${pr.ci_state} on ${pr.head_sha.slice(0, 7)}.`, "agent", 90);
  if (pr.bot_reviews_on_head && pr.unresolved_bot_threads > 0)
    add("needs-addressing", "Address review feedback", `${pr.unresolved_bot_threads} unresolved bot threads on the reviewed head.`, "agent", 80);
  if (v.stage === "ready-to-merge")
    add("ready-to-merge", "Review merge readiness", "Review and CI gates are satisfied in the cached state.", "human", 70);
  return actions;
}

export function itemActions(view: ItemView): NextAction[] {
  const { item } = view;
  const blocker = item.blocked_reason?.trim();
  const order = parseJsonArray(item.repo_order);
  const actions = view.worktrees.flatMap(worktreeActions);
  for (const v of view.prs) {
    for (const action of prActions(v)) {
      if (action.kind === "ready-to-merge") {
        const position = order.indexOf(v.pr.repo);
        const missing = position < 0 ? [] : order.slice(0, position).filter((repo) => {
          const earlier = view.prs.filter((p) => p.pr.repo === repo && p.pr.state !== "CLOSED");
          return earlier.length === 0 || earlier.some((p) => p.pr.state !== "MERGED");
        });
        if (blocker || missing.length || actions.some((a) => a.kind === "local-only" || a.kind === "unknown-local-state")) {
          action.kind = "merge-prerequisite";
          action.title = `Check merge prerequisites: ${v.pr.repo}#${v.pr.number}`;
          action.reason = blocker || (missing.length ? `Waiting for earlier repositories: ${missing.join(", ")}.` : "Inspect the item's local changes before considering a merge.");
          action.priority = 45;
        } else if (position >= 0) {
          const dependents = view.prs.filter((p) => p.pr.state === "OPEN" && order.indexOf(p.pr.repo) > position).length;
          if (dependents) {
            action.reason += ` Comes before ${dependents} downstream PR${dependents === 1 ? "" : "s"} in the recorded merge order.`;
            action.priority += Math.min(dependents, 9);
          }
        }
      }
      actions.push(action);
    }
  }
  if (view.needs_testing && view.stage !== "needs-testing") {
    const [title, reason, priority] = STAGE_ACTIONS["needs-testing"]!;
    actions.push({ id: `item:${item.id}:needs-testing`, item_id: item.id, project: item.project,
      kind: "needs-testing", actor: "human", title, reason, priority });
  }
  const stageAction = STAGE_ACTIONS[view.stage];
  if (stageAction && !actions.some((a) => a.kind === view.stage) &&
      !(view.stage === "ready-to-merge" && actions.some((a) => a.kind === "merge-prerequisite"))) {
    actions.push({ id: `item:${item.id}:${view.stage}`, item_id: item.id, project: item.project,
      kind: view.stage, actor: actorFor(view.stage) ?? "human", title: stageAction[0],
      reason: view.stage === "blocked" ? item.blocked_reason || stageAction[1] : stageAction[1], priority: stageAction[2] });
  }
  return sortActions(actions.map((a) => ({ ...a, item_id: item.id, project: item.project })));
}

export function nextActions(sections: LsSections): NextAction[] {
  return sortActions([
    ...sections.items.filter((v) => !v.item.archived_at).flatMap(itemActions),
    ...sections.unlinked.flatMap(prActions),
    ...sections.worktrees.untracked.flatMap(worktreeActions),
  ]);
}

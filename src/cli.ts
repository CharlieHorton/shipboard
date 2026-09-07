#!/usr/bin/env node
/**
 * shipboard — cross-project pipeline tracker.
 *
 * Every command opens the config and the store, derives stages from what sync
 * recorded, and prints. Nothing here writes PR columns; sync owns those.
 */
import { Command } from "commander";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { findRepo, loadConfig } from "./config.js";
import { addProjectRepository, discoverRepository, type ProjectOptions } from "./project-config.js";
import * as cron from "./cron.js";
import { nowIso, openDb, type Db } from "./db.js";
import { ciGlyph, linearUrl, relTime, repoLabel, repoShortName, table, tildePath } from "./format.js";
import { repoForCwd } from "./github.js";
import { itemActions, nextActions } from "./actions.js";
import { buildResume, formatResume } from "./resume.js";
import { readSyncHealth } from "./sync-health.js";
import { evidenceMatches, manualDeployCoversCurrentPrs } from "./evidence.js";
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "./server.js";
import * as store from "./store.js";
import { syncAll, type SyncResult } from "./sync.js";
import {
  collect,
  groupBySilo,
  jsonSections,
  localWorktrees,
  viewItem,
  worktreeCount,
  worktreeRemoveCommand,
  type ItemView,
  type PrView,
  type WorktreeView,
} from "./views.js";
import {
  ITEM_STAGES,
  TASK_KINDS,
  repoKey,
  type Config,
  type ItemRow,
  type ItemStage,
  type PrRow,
  type RepoKey,
  type TaskKind,
} from "./types.js";

const program = new Command();
program
  .name("shipboard")
  .description("Track work items across repos: branch → review → merge → deploy → test.")
  .option("--db <path>", "SQLite path (overrides SHIPBOARD_DB)")
  .showHelpAfterError();

// ---------- plumbing ----------

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function ctx(): { cfg: Config; db: Db } {
  const dbPath = program.opts<{ db?: string }>().db;
  if (dbPath) process.env["SHIPBOARD_DB"] = dbPath;
  return { cfg: loadConfig(), db: openDb() };
}

function posInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`${label} must be a positive integer, got "${raw}"`);
  return n;
}

function mustItem(db: Db, id: number): ItemRow {
  const item = store.getItem(db, id);
  if (!item) fail(`No item #${id}.`);
  return item;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function prRef(pr: PrRow): string {
  return `${repoLabel(pr.repo)}#${pr.number}`;
}

/** "API#205 needs-addressing(4)" */
function prCell(v: PrView): string {
  const threads =
    v.pr.state === "OPEN" && v.pr.unresolved_bot_threads > 0 ? `(${v.pr.unresolved_bot_threads})` : "";
  return `${prRef(v.pr)} ${v.stage}${threads}`;
}

// ---------- worktrees ----------

/** "API⎇feature/sample-feature local-only(2)" */
function wtCell(v: WorktreeView): string {
  const count = worktreeCount(v);
  return `${repoLabel(v.wt.repo)}⎇${v.wt.branch} ${v.stage}(${count < 0 ? "unknown" : count}${v.wt.dirty === 1 ? "; uncommitted changes" : ""})`;
}

/** The same plus the age of the last commit: forgotten work is about age. */
function wtCellAged(v: WorktreeView): string {
  return `${wtCell(v)} ${relTime(v.wt.last_commit_at)}`;
}

/** One line per silo: "sample-feature  API⎇feature/sample-feature local-only(2) 1d ago · web⎇…". */
function renderSilos(views: WorktreeView[]): string[] {
  const rows = [...groupBySilo(views)].map(([silo, list]) => [
    silo,
    list.map(wtCellAged).join(" · "),
  ]);
  return table(rows).map((line) => `  ${line}`);
}

/** Cleanup suggestions explicitly select the owning repository with git -C. */
function renderHousekeeping(views: WorktreeView[]): string[] {
  const rows = views.map((v) => {
    const path = tildePath(v.wt.path);
    return [
      repoLabel(v.wt.repo),
      path,
      v.pr ? `${v.stage} (PR #${v.pr.number})` : v.stage,
      worktreeRemoveCommand(v) ?? "Removal command unavailable: verify the owning checkout and local state",
    ];
  });
  return table(rows).map((line) => `  ${line}`);
}

// ---------- ls ----------

function renderItems(views: ItemView[]): string[] {
  if (views.length === 0) return ["No items."];
  const rows = [["ID", "STAGE", "ACTOR", "PROJECT", "TITLE", "PRS"]];
  for (const v of views) {
    rows.push([
      `#${v.item.id}`,
      v.stage,
      v.actor ?? "-",
      v.item.project,
      v.item.title,
      [...v.prs.map(prCell), ...localWorktrees(v.worktrees).map(wtCell)].join(" · "),
    ]);
  }
  return table(rows);
}

/** "API#237 chinese → develop  needs-addressing(3) round 1  ci ✓" */
function renderPrLines(views: PrView[]): string[] {
  const rows = views.map((v) => {
    const threads = v.pr.unresolved_bot_threads > 0 ? `(${v.pr.unresolved_bot_threads})` : "";
    return [
      `${prRef(v.pr)} ${v.pr.head_branch} → ${v.pr.base_branch}`,
      `${v.stage}${threads} round ${v.pr.review_round}`,
      `ci ${ciGlyph(v.pr.ci_state) || "-"}`,
    ];
  });
  return table(rows).map((line) => `  ${line}`);
}

function renderRelease(entries: { view: PrView; contains: number }[]): string[] {
  const rows = entries.map((e) => [
    `${prRef(e.view.pr)} ${e.view.pr.head_branch} → ${e.view.pr.base_branch}`,
    e.view.stage,
    `contains ${e.contains} PR${e.contains === 1 ? "" : "s"}`,
  ]);
  return table(rows).map((line) => `  ${line}`);
}

/** "API#205 (4 threads)" for the PRs that put the item in its stage. */
function attentionPrs(v: ItemView): string {
  if (v.stage === "blocked") return v.item.blocked_reason ?? "";
  const driving = v.prs.filter((p) => p.stage === v.stage);
  const shown = driving.length > 0 ? driving : v.prs.filter((p) => p.stage !== "closed");
  const prs = shown.map((p) => {
    const n = p.pr.unresolved_bot_threads;
    // Thread counts only matter while the PR is still open.
    if (p.pr.state !== "OPEN" || n === 0) return prRef(p.pr);
    return `${prRef(p.pr)} (${n} thread${n === 1 ? "" : "s"})`;
  });
  // A branch with no PR is the whole story for a local-only item.
  return [...prs, ...localWorktrees(v.worktrees).map(wtCell)].join(" · ");
}

function renderAttentionGroup(heading: string, views: ItemView[]): string[] {
  if (views.length === 0) return [];
  const lines = table(
    views.map((v) => [`#${v.item.id} ${v.stage}`, v.item.title, attentionPrs(v)]),
  );
  const out = [heading];
  lines.forEach((line, i) => {
    out.push(`  ${line}`);
    for (const w of views[i]!.warnings) out.push(`    ! ${w}`);
  });
  return out;
}

// ---------- commands ----------

program.command("project")
  .description("Configure projects and their repositories")
  .command("add <name>")
  .description("Add a repository to a new or existing project; detects the current checkout by default")
  .option("--repo <owner/name>", "GitHub repository; without --local, configure GitHub-only tracking")
  .option("--local <path>", "local checkout (resolves linked worktrees to the main checkout)")
  .option("--dev-branch <branch>", "development branch (detected develop, otherwise production branch)")
  .option("--prod-branch <branch>", "production branch (origin/HEAD, main, master, then main fallback)")
  .option("--deploy <mode>", "production deployment: manual or auto", "manual")
  .action((name: string, opts: ProjectOptions) => {
    try {
      const repo = discoverRepository(opts);
      const path = addProjectRepository(name, repo);
      console.log(`Added ${repoKey(repo)} to project "${name.trim()}".`);
      console.log(`Branches: ${repo.dev_branch} → ${repo.prod_branch}; production deploy: ${repo.deploy}.`);
      console.log(`Local checkout: ${repo.local ?? "none (GitHub-only tracking)"}`);
      console.log(`Saved ${path}. Restart any running dashboard/MCP server to load this configuration.`);
      console.log(`Next: shipboard sync --repo ${repoKey(repo)}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command("sync")
  .description("Poll GitHub and update the store")
  .option("--repo <owner/name|path>", "one configured repo key, or a directory inside one")
  .option("--json", "print the raw SyncResult[]")
  .action(async (opts: { repo?: string; json?: boolean }) => {
    const { cfg, db } = ctx();
    const results: SyncResult[] =
      opts.repo === undefined
        ? await syncAll(db, cfg)
        : await syncAll(db, cfg, { repos: [resolveRepoOption(cfg, opts.repo)] });

    if (opts.json) {
      printJson(results);
    } else {
      for (const r of results) {
        // The worktree scan is the other half of sync; a repo with no local
        // checkout (or an older SyncResult) has nothing to report.
        const seen = (r as { worktrees_seen?: number }).worktrees_seen ?? 0;
        const wts = seen === 0 ? "" : ` · ${seen} worktree${seen === 1 ? "" : "s"}`;
        console.log(`${repoShortName(r.repo)}: ${r.prs_seen} PRs, ${r.prs_changed} changed${wts}`);
        for (const c of r.changes) {
          console.log(`  #${c.number} ${c.field} ${fmtVal(c.from)} → ${fmtVal(c.to)}`);
        }
      }
    }
    for (const r of results) {
      for (const e of r.errors) console.error(`${repoShortName(r.repo)}: ${e}`);
    }
    if (results.some((r) => r.errors.length > 0)) process.exit(1);
  });

function resolveRepoOption(cfg: Config, value: string): RepoKey {
  if (value.includes("/") && !value.startsWith(".") && findRepo(cfg, value)) return value;
  const repo = repoForCwd(resolve(value), cfg);
  if (!repo) fail(`--repo "${value}" is not a configured repo key or a directory inside one.`);
  return repoKey(repo);
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

program
  .command("next")
  .description("Rank next actions from the local cache; does not sync or execute anything")
  .option("--project <name>", "limit to one project")
  .option("--limit <count>", "maximum actions", "3")
  .option("--json", "machine-readable actions and source health")
  .action((opts: { project?: string; limit: string; json?: boolean }) => {
    const { cfg, db } = ctx();
    const scope = opts.project === undefined ? {} : { project: opts.project };
    const actions = nextActions(collect(db, cfg, scope)).slice(0, posInt("limit", opts.limit));
    const health = readSyncHealth(db, cfg, scope);
    if (opts.json) return printJson({ actions, health });
    console.log(actions.length ? actions.map((a, i) => `${i + 1}. [${a.actor}] ${a.title}${a.item_id ? ` (item #${a.item_id})` : ""}\n   ${a.reason}`).join("\n") : "No derived actions in the cached state.");
    for (const h of health.filter((h) => h.status !== "healthy")) console.log(`! ${h.repo} / ${h.source}: ${h.status}${h.errors.length ? ` — ${h.errors.join("; ")}` : ""}`);
  });

program
  .command("resume")
  .description("A read-only context briefing from cached work, tasks, and notes")
  .argument("<id>")
  .option("--json", "machine-readable briefing")
  .action((rawId: string, opts: { json?: boolean }) => {
    const { cfg, db } = ctx();
    const id = posInt("id", rawId);
    const brief = buildResume(db, cfg, id);
    if (!brief) return fail(`No item #${id}.`);
    if (opts.json) printJson(brief);
    else console.log(formatResume(brief));
  });

program
  .command("ls")
  .description("List items, plus open PRs nothing is tracking")
  .option("--attention", "only what an agent or you must act on")
  .option("--project <name>", "limit to one project")
  .option("--all", "include PRs from ignored authors (dependabot etc)")
  .option("--archived", "include archived items")
  .option("--json", "machine-readable output")
  .action((opts: { attention?: boolean; project?: string; all?: boolean; archived?: boolean; json?: boolean }) => {
    const { cfg, db } = ctx();
    const sections = collect(db, cfg, {
      all: opts.all === true,
      archived: opts.archived === true,
      attention: opts.attention === true,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
    });
    const { items, unlinked } = sections;

    if (opts.json) {
      printJson({ ...jsonSections(sections), health: readSyncHealth(db, cfg, opts.project === undefined ? {} : { project: opts.project }) });
      return;
    }

    const { untracked, housekeeping } = sections.worktrees;

    const blocks: string[][] = [];
    if (opts.attention) {
      if (items.length === 0 && unlinked.length === 0 && untracked.length === 0) {
        console.log("Nothing needs attention.");
        return;
      }
      for (const actor of ["agent", "human"] as const) {
        const actions = nextActions(sections).filter((a) => a.actor === actor);
        if (actions.length) blocks.push([actor === "agent" ? "Agent can act" : "Needs you", ...actions.map((a) => `  ${a.item_id ? `#${a.item_id} ` : ""}${a.title}\n    ${a.reason}`)]);
      }
    } else {
      blocks.push(renderItems(items));
    }

    if (unlinked.length > 0) blocks.push(["Unlinked open PRs", ...renderPrLines(unlinked)]);
    if (!opts.attention) {
      if (untracked.length > 0) blocks.push(["Untracked worktrees", ...renderSilos(untracked)]);
      if (housekeeping.length > 0) {
        blocks.push(["Worktrees to clean up (recheck local changes before removal)", ...renderHousekeeping(housekeeping)]);
      }
    }
    if (!opts.attention && sections.release.length > 0) {
      blocks.push(["Release PRs", ...renderRelease(sections.release)]);
    }
    console.log(
      blocks
        .filter((b) => b.length > 0)
        .map((b) => b.join("\n"))
        .join("\n\n"),
    );
  });

program
  .command("show")
  .description("Everything known about one item")
  .argument("<id>")
  .action((rawId: string) => {
    const { cfg, db } = ctx();
    const id = posInt("id", rawId);
    const v = viewItem(db, cfg, mustItem(db, id));

    const header: string[][] = [
      ["stage", `${v.stage}${v.actor ? `  (${v.actor})` : ""}`],
      ["project", v.item.project],
    ];
    const linear = v.item.linear_key;
    if (linear) {
      const url = linearUrl(cfg, linear);
      header.push(["linear", url === undefined ? linear : `${linear}  ${url}`]);
    }
    if (v.item.blocked_reason) header.push(["blocked", v.item.blocked_reason]);
    if (v.item.prod_deployed_at) header.push([manualDeployCoversCurrentPrs(v.item, v.prs.map((p) => p.pr)) ? "prod confirmed" : "previous prod confirmation (reconfirm)", relTime(v.item.prod_deployed_at)]);

    const out = [`#${v.item.id}  ${v.item.title}`, ...table(header)];
    const actions = itemActions(v);
    if (actions.length) out.push("", "Next actions", ...actions.map((a) => `  [${a.actor}] ${a.title} — ${a.reason}`));

    if (v.item.summary) out.push("", v.item.summary);

    const changes = store.parseJsonArray(v.item.changes);
    if (changes.length > 0) out.push("", "Changes", ...changes.map((c) => `  - ${c}`));

    out.push("", "PRs");
    if (v.prs.length === 0) {
      out.push("  none linked");
    } else {
      const rows = v.prs.map((p) => [
        prRef(p.pr),
        p.stage,
        `${p.pr.head_branch} → ${p.pr.base_branch}`,
        `round ${p.pr.review_round}`,
        `unresolved ${p.pr.unresolved_bot_threads}`,
        `ci ${ciGlyph(p.pr.ci_state) || "-"}`,
        `dev ${p.pr.on_dev ? "✓" : "-"}`,
        `prod ${p.pr.on_prod ? "✓" : "-"}`,
        `shipped ${p.pr.deployed_at ? "✓" : "-"}`,
        p.pr.in_release_pr != null ? `release #${p.pr.in_release_pr}` : "",
      ]);
      out.push(...table(rows).map((l) => `  ${l}`));
    }
    for (const w of v.warnings) out.push(`  ! ${w}`);

    if (v.worktrees.length > 0) {
      out.push("", "Worktrees");
      const rows = v.worktrees.map((w) => [
        tildePath(w.wt.path),
        w.wt.branch,
        w.stage,
        `ahead ${w.wt.ahead_of_dev < 0 ? "unknown" : w.wt.ahead_of_dev}`,
        `unpushed ${w.wt.unpushed < 0 ? "unknown" : w.wt.unpushed}`,
        `dirty ${w.wt.dirty === -1 ? "unknown" : w.wt.dirty === 1 ? "✓" : "-"}`,
        `last commit ${relTime(w.wt.last_commit_at)}`,
      ]);
      out.push(...table(rows).map((l) => `  ${l}`));
    }

    const tasks = store.tasksForItem(db, v.item.id);
    if (tasks.length > 0) {
      out.push("", "Tasks");
      out.push(
        ...table(
          tasks.map((t) => [`  [${t.done_at ? "x" : " "}]`, String(t.id), t.kind, t.text,
            t.done_at && t.kind === "test" && !evidenceMatches(t.completion_evidence, v.prs.map((p) => p.pr)) ? "reconfirm for current commits" : ""]),
        ),
      );
    }

    const events = store.eventsForItem(db, v.item.id, 15);
    if (events.length > 0) {
      out.push("", "Events");
      out.push(...table(events.map((e) => [`  ${relTime(e.at)}`, e.source, e.text])));
    }
    console.log(out.join("\n"));
  });

const itemCmd = program.command("item").description("Create and edit work items");

itemCmd
  .command("add")
  .description("Create a work item")
  .option("--project <name>", "project (defaults to the only configured project)")
  .requiredOption("--title <title>", "one-line title")
  .option("--summary <text>", "one-paragraph summary")
  .option("--change <text>", "a 'what changed' bullet (repeatable)", collectValue, [])
  .option("--order <repos>", "required merge order, e.g. owner/a,owner/b")
  .option("--linear <key>", "Linear issue key")
  .option("--silo <name>", "worktree silo directory, e.g. crm-signup-link")
  .action(
    (opts: {
      project?: string;
      title: string;
      summary?: string;
      change: string[];
      order?: string;
      linear?: string;
      silo?: string;
    }) => {
      const { cfg, db } = ctx();
      const project = opts.project ?? defaultProject(cfg);
      const input: store.NewItem = { project, title: opts.title };
      if (opts.summary !== undefined) input.summary = opts.summary;
      if (opts.change.length > 0) input.changes = opts.change;
      if (opts.order !== undefined) input.repo_order = splitCsv(opts.order);
      if (opts.linear !== undefined) input.linear_key = opts.linear;
      if (opts.silo !== undefined) input.silo = opts.silo;

      const item = store.createItem(db, input);
      store.addEvent(db, item.id, "user", `created item "${item.title}"`);
      console.log(`Created item #${item.id}`);
    },
  );

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function defaultProject(cfg: Config): string {
  const only = cfg.projects.length === 1 ? cfg.projects[0] : undefined;
  if (!only) {
    fail(
      `--project is required (configured: ${cfg.projects.map((p) => p.name).join(", ") || "none"}).`,
    );
  }
  return only.name;
}

program
  .command("link")
  .description("Attach a PR — or a whole worktree silo — to an item")
  .argument("<itemId>")
  .argument("<ref>", "owner/name#123, owner/name:branch, #123, a branch name, or silo:<name>")
  .action((rawItemId: string, ref: string) => {
    const { cfg, db } = ctx();
    const itemId = posInt("itemId", rawItemId);
    mustItem(db, itemId);

    if (ref.startsWith("silo:")) {
      linkSilo(db, itemId, ref.slice("silo:".length));
      return;
    }

    const target = parseRef(cfg, ref);
    const pr =
      target.kind === "number"
        ? store.findPr(db, target.repo, target.number)
        : store.findPrByBranch(db, target.repo, target.branch);
    if (!pr) {
      const what = target.kind === "number" ? `#${target.number}` : `branch ${target.branch}`;
      fail(
        `No PR ${what} for ${target.repo} in the store yet. Run \`shipboard sync --repo ${target.repo}\` first.`,
      );
    }
    store.linkPr(db, itemId, pr.id);
    console.log(`Linked ${prRef(pr)} to item #${itemId}`);
  });

/** `link <item> silo:<name>` — attach every worktree of a feature directory. */
function linkSilo(db: Db, itemId: number, silo: string): void {
  const known = [...new Set(store.listWorktrees(db).map((w) => w.silo).filter((s) => s !== ""))].sort();
  if (!known.includes(silo)) {
    const list = known.length > 0 ? known.join(", ") : "none yet — run shipboard sync";
    fail(`No worktree silo "${silo}". Known silos: ${list}.`);
  }
  store.updateItem(db, itemId, { silo });
  store.addEvent(db, itemId, "user", `linked silo ${silo}`);
  const n = store.listWorktrees(db, { silo }).filter((w) => !w.is_main).length;
  console.log(`Linked silo ${silo} to item #${itemId} (${n} worktree${n === 1 ? "" : "s"})`);
}

type PrTarget =
  | { kind: "number"; repo: RepoKey; number: number }
  | { kind: "branch"; repo: RepoKey; branch: string };

function parseRef(cfg: Config, ref: string): PrTarget {
  const hash = ref.lastIndexOf("#");
  if (hash !== -1) {
    const left = ref.slice(0, hash);
    return {
      kind: "number",
      repo: left === "" ? cwdRepo(cfg) : left,
      number: posInt("PR number", ref.slice(hash + 1)),
    };
  }
  const colon = ref.indexOf(":");
  if (colon !== -1) {
    return { kind: "branch", repo: ref.slice(0, colon), branch: ref.slice(colon + 1) };
  }
  return { kind: "branch", repo: cwdRepo(cfg), branch: ref };
}

function cwdRepo(cfg: Config): RepoKey {
  const repo = repoForCwd(process.cwd(), cfg);
  if (!repo) fail(`No configured repo for ${process.cwd()}. Use owner/name#123.`);
  return repoKey(repo);
}

program
  .command("set")
  .description("Edit the tracker-owned fields of an item")
  .argument("<itemId>")
  .option("--stage <stage>", `override the derived stage (${ITEM_STAGES.join(", ")})`)
  .option("--clear-stage", "drop the override and derive again")
  .option("--blocked <reason>", "mark blocked")
  .option("--unblock", "clear the blocker")
  .option("--order <repos>", "required merge order, e.g. owner/a,owner/b")
  .option("--summary <text>", "replace the summary")
  .option("--title <text>", "replace the title")
  .option("--linear <key>", "set the Linear issue key")
  .option("--silo <name>", "worktree silo directory, e.g. crm-signup-link")
  .action(
    (
      rawId: string,
      opts: {
        stage?: string;
        clearStage?: boolean;
        blocked?: string;
        unblock?: boolean;
        order?: string;
        summary?: string;
        title?: string;
        linear?: string;
        silo?: string;
      },
    ) => {
      const { cfg, db } = ctx();
      const id = posInt("itemId", rawId);
      mustItem(db, id);

      if (opts.stage && opts.clearStage) fail("--stage and --clear-stage conflict.");
      if (opts.blocked && opts.unblock) fail("--blocked and --unblock conflict.");

      const patch: store.ItemPatch = {};
      const changed: string[] = [];
      if (opts.stage !== undefined) {
        if (!ITEM_STAGES.includes(opts.stage as ItemStage)) {
          fail(`Unknown stage "${opts.stage}". One of: ${ITEM_STAGES.join(", ")}`);
        }
        patch.stage_override = opts.stage as ItemStage;
        changed.push(`stage=${opts.stage}`);
      }
      if (opts.clearStage) {
        patch.stage_override = null;
        changed.push("cleared stage override");
      }
      if (opts.blocked !== undefined) {
        patch.blocked_reason = opts.blocked;
        changed.push(`blocked: ${opts.blocked}`);
      }
      if (opts.unblock) {
        patch.blocked_reason = null;
        changed.push("unblocked");
      }
      if (opts.order !== undefined) {
        const order = splitCsv(opts.order);
        patch.repo_order = JSON.stringify(order);
        changed.push(`order=${order.join(" → ")}`);
      }
      if (opts.summary !== undefined) {
        patch.summary = opts.summary;
        changed.push("summary");
      }
      if (opts.title !== undefined) {
        patch.title = opts.title;
        changed.push(`title=${opts.title}`);
      }
      if (opts.linear !== undefined) {
        patch.linear_key = opts.linear;
        changed.push(`linear=${opts.linear}`);
      }
      if (opts.silo !== undefined) {
        patch.silo = opts.silo;
        changed.push(`silo=${opts.silo}`);
      }
      if (changed.length === 0) fail("Nothing to set.");

      const item = store.updateItem(db, id, patch);
      store.addEvent(db, id, "user", `set ${changed.join(", ")}`);
      const v = viewItem(db, cfg, item);
      console.log(`Updated item #${id}: ${changed.join(", ")} — now ${v.stage}`);
    },
  );

const taskCmd = program.command("task").description("Post-deploy chores and the test gate");

taskCmd
  .command("add")
  .description("Add a task to an item")
  .argument("<itemId>")
  .argument("<text...>")
  .requiredOption("--kind <kind>", `one of ${TASK_KINDS.join(", ")}`)
  .action((rawId: string, text: string[], opts: { kind: string }) => {
    const { db } = ctx();
    const id = posInt("itemId", rawId);
    mustItem(db, id);
    if (!TASK_KINDS.includes(opts.kind as TaskKind)) {
      fail(`Unknown task kind "${opts.kind}". One of: ${TASK_KINDS.join(", ")}`);
    }
    const body = text.join(" ");
    const task = store.addTask(db, id, opts.kind as TaskKind, body);
    store.addEvent(db, id, "user", `task ${task.kind}: ${body}`);
    console.log(`Added task ${task.id} (${task.kind}) to item #${id}`);
  });

taskCmd
  .command("done")
  .description("Complete a task")
  .argument("<taskId>")
  .action((rawId: string) => {
    const { db } = ctx();
    const taskId = posInt("taskId", rawId);
    const existing = store.getTask(db, taskId);
    if (!existing) fail(`No task ${taskId}.`);
    const task = store.completeTask(db, taskId);
    store.addEvent(db, task.item_id, "user", `done ${task.kind}: ${task.text}`);
    console.log(`Completed task ${task.id} (${task.kind}) on item #${task.item_id}`);
  });

program
  .command("note")
  .description("Append a note to an item's timeline")
  .argument("<itemId>")
  .argument("<text...>")
  .action((rawId: string, text: string[]) => {
    const { db } = ctx();
    const id = posInt("itemId", rawId);
    mustItem(db, id);
    store.addEvent(db, id, "user", text.join(" "));
    console.log(`Noted on item #${id}`);
  });

program
  .command("deployed")
  .description("Assert a manual production deploy")
  .argument("<itemId>")
  .argument("<env>", "prod")
  .action((rawId: string, env: string) => {
    const { cfg, db } = ctx();
    const id = posInt("itemId", rawId);
    mustItem(db, id);
    if (env.toLowerCase() !== "prod") fail(`Only "prod" can be asserted; dev is derived.`);
    const at = nowIso();
    const item = store.updateItem(db, id, { prod_deployed_at: at });
    store.addEvent(db, id, "user", "deployed to prod");
    console.log(`Item #${id} deployed to prod — now ${viewItem(db, cfg, item).stage}`);
  });

program
  .command("archive")
  .description("Hide an item from the default listing")
  .argument("<itemId>")
  .action((rawId: string) => {
    const { db } = ctx();
    const id = posInt("itemId", rawId);
    mustItem(db, id);
    store.updateItem(db, id, { archived_at: nowIso() });
    store.addEvent(db, id, "user", "archived");
    console.log(`Archived item #${id}`);
  });

// ---------- cron (launchd; no DB, so no ctx()) ----------

const cronCmd = program
  .command("cron")
  .description("Run `shipboard sync` in the background via launchd");

/** cron commands only ever fail with a message worth reading. */
function runCron(fn: () => string): void {
  try {
    console.log(fn());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

cronCmd
  .command("install")
  .description(`Install the ${cron.LABEL} LaunchAgent`)
  .option("--interval <seconds>", `seconds between syncs (default ${cron.DEFAULT_INTERVAL})`)
  .action((opts: { interval?: string }) => {
    runCron(() => cron.install(cron.parseInterval(opts.interval)));
  });

cronCmd
  .command("uninstall")
  .description("Unload the LaunchAgent and delete its plist")
  .action(() => {
    runCron(() => cron.uninstall());
  });

cronCmd
  .command("status")
  .description("Whether the LaunchAgent is installed, loaded, and what it last logged")
  .action(() => {
    runCron(() => cron.status());
  });

program
  .command("serve")
  .description("Run the dashboard on localhost")
  .option("--port <n>", `port to listen on (default ${DEFAULT_PORT})`)
  .option("--host <h>", `address to bind (default ${DEFAULT_HOST})`)
  .option("--open", "open the dashboard in a browser (macOS)")
  .action(async (opts: { port?: string; host?: string; open?: boolean }) => {
    const { cfg, db } = ctx();
    const { server, url } = await startServer(db, cfg, {
      ...(opts.port !== undefined ? { port: posInt("--port", opts.port) } : {}),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
    });
    console.log(`Shipboard dashboard: ${url}`);
    // Best effort; a missing browser is not worth failing the server over.
    if (opts.open && process.platform === "darwin") execFile("open", [url], () => {});
    process.on("SIGINT", () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
  });

await program.parseAsync(process.argv);

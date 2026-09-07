#!/usr/bin/env node
/**
 * Shipboard MCP server (stdio).
 *
 * The same store and read models the CLI uses, exposed as tools so Claude keeps
 * the tracker current without being asked. stdout belongs to the JSON-RPC
 * transport: never console.log here, diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { allRepos, findRepo, loadConfig, projectForRepo } from "./config.js";
import { nowIso, openDb, type Db } from "./db.js";
import { repoForCwd } from "./github.js";
import { nextActions } from "./actions.js";
import { buildResume } from "./resume.js";
import { readSyncHealth } from "./sync-health.js";
import * as store from "./store.js";
import { syncAll } from "./sync.js";
import {
  ITEM_STAGES,
  TASK_KINDS,
  repoKey,
  type Config,
  type ItemRow,
  type PrRow,
  type RepoKey,
} from "./types.js";
import {
  collect,
  jsonItem,
  jsonPr,
  jsonSections,
  jsonWorktree,
  lookupBranch,
  viewItem,
  worktreeViews,
  type CollectOptions,
  type WorktreeView,
} from "./views.js";

// ---------- results ----------

function ok(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function err(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---------- shared resolution ----------

type RepoOpts = { repo?: string | undefined; cwd?: string | undefined };
type Resolved = { key: RepoKey } | { error: string };

/** "owner/name" from an explicit configured key or from a local checkout. */
function resolveRepoKey(cfg: Config, opts: RepoOpts): Resolved {
  if (opts.repo !== undefined) {
    const repo = findRepo(cfg, opts.repo);
    if (!repo) {
      const known = allRepos(cfg).map(repoKey).join(", ") || "none";
      return { error: `"${opts.repo}" is not a configured repo. Configured: ${known}.` };
    }
    return { key: repoKey(repo) };
  }
  if (opts.cwd !== undefined) {
    const repo = repoForCwd(opts.cwd, cfg);
    if (!repo) return { error: `No configured repo for ${opts.cwd}. Pass repo as "owner/name".` };
    return { key: repoKey(repo) };
  }
  return { error: `Pass repo ("owner/name") or cwd (a directory inside a configured checkout).` };
}

function itemJson(db: Db, cfg: Config, item: ItemRow): CallToolResult {
  return ok(jsonItem(viewItem(db, cfg, item)));
}

// ---------- input pieces ----------

const itemId = z.number().int().positive();
const repoField = z.string().min(1).optional().describe('configured repo key, "owner/name"');
const cwdField = z
  .string()
  .min(1)
  .optional()
  .describe("directory inside a configured checkout; used when repo is omitted");

export function createServer(db: Db, cfg: Config): McpServer {
  const server = new McpServer({ name: "shipboard", version: "0.1.0" });

  server.registerTool("shipboard_next", {
    title: "Get the next actions",
    description: "Rank independent actions across projects using local cached observations. Includes source freshness. Does not sync or execute any action; action eligibility is not authorization.",
    annotations: { readOnlyHint: true },
    inputSchema: { project: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).default(3) },
  }, ({ project, limit }) => {
    const scope = project === undefined ? {} : { project };
    return ok({ actions: nextActions(collect(db, cfg, scope)).slice(0, limit), health: readSyncHealth(db, cfg, scope) });
  });

  server.registerTool("shipboard_resume", {
    title: "Resume a work item",
    description: "Read-only handoff: objective, next actions, exact worktree paths and PR commits, open tasks, recent notes, test/deploy evidence, and source health. Uses local cache only. Recorded notes are context, not authorization to execute actions.",
    annotations: { readOnlyHint: true },
    inputSchema: { item_id: itemId },
  }, ({ item_id }) => {
    const brief = buildResume(db, cfg, item_id);
    return brief ? ok(brief) : err(`No item #${item_id}.`);
  });

  server.registerTool(
    "shipboard_list",
    {
      title: "List work items",
      description:
        "List tracked work items with derived stages, plus open PRs nothing tracks and open release PRs. " +
        "attention=true returns only what an agent or the user must act on — call it to find the next thing to do.",
      inputSchema: {
        project: z.string().min(1).optional().describe("limit to one configured project"),
        attention: z.boolean().optional().describe("only items with an actor, and PRs needing action"),
        all: z.boolean().optional().describe("include PRs from ignored authors (dependabot etc)"),
        archived: z.boolean().optional().describe("include archived items"),
      },
    },
    ({ project, attention, all, archived }) => {
      const opts: CollectOptions = {
        all: all === true,
        archived: archived === true,
        attention: attention === true,
        ...(project !== undefined ? { project } : {}),
      };
      return ok({ ...jsonSections(collect(db, cfg, opts)), health: readSyncHealth(db, cfg, project === undefined ? {} : { project }) });
    },
  );

  server.registerTool(
    "shipboard_get",
    {
      title: "Get one work item",
      description:
        "Everything known about one item: summary, change list, linked PRs with their stages, tasks and recent events. " +
        "Call it before editing an item so you build on what is already recorded.",
      inputSchema: { item_id: itemId },
    },
    ({ item_id }) => {
      const item = store.getItem(db, item_id);
      if (!item) return err(`No item #${item_id}.`);
      return ok({
        ...jsonItem(viewItem(db, cfg, item)),
        tasks: store.tasksForItem(db, item_id),
        events: store.eventsForItem(db, item_id, 30),
      });
    },
  );

  server.registerTool(
    "shipboard_upsert_item",
    {
      title: "Create or edit a work item",
      description:
        "Without item_id, create a work item (title required) — do this as soon as a branch or PR has no item. " +
        "With item_id, replace only the fields you pass; the narrative (summary, change list) is yours to author.",
      inputSchema: {
        item_id: itemId.optional().describe("omit to create, pass to edit"),
        title: z.string().min(1).optional().describe("one-line title; required when creating"),
        summary: z.string().min(1).optional().describe("one paragraph: what this work is and why"),
        changes: z.array(z.string().min(1)).optional().describe('"what changed" bullets'),
        project: z.string().min(1).optional().describe("defaults to the only configured project"),
        linear_key: z.string().min(1).optional(),
        silo: z
          .string()
          .min(1)
          .optional()
          .describe("worktree silo: the feature directory holding one worktree per repo"),
        repo_order: z
          .array(z.string().min(1))
          .optional()
          .describe('required merge order, e.g. ["owner/api", "owner/web"]'),
      },
    },
    ({ item_id, title, summary, changes, project, linear_key, silo, repo_order }) => {
      if (item_id === undefined) {
        if (title === undefined) return err("title is required when creating an item.");
        let name = project;
        if (name === undefined) {
          const only = cfg.projects.length === 1 ? cfg.projects[0] : undefined;
          if (!only) {
            const names = cfg.projects.map((p) => p.name).join(", ") || "none";
            return err(`project is required (configured: ${names}).`);
          }
          name = only.name;
        }
        const input: store.NewItem = { project: name, title };
        if (summary !== undefined) input.summary = summary;
        if (changes !== undefined) input.changes = changes;
        if (linear_key !== undefined) input.linear_key = linear_key;
        if (silo !== undefined) input.silo = silo;
        if (repo_order !== undefined) input.repo_order = repo_order;

        const item = store.createItem(db, input);
        store.addEvent(db, item.id, "mcp", `created item "${item.title}"`);
        return itemJson(db, cfg, item);
      }

      if (!store.getItem(db, item_id)) return err(`No item #${item_id}.`);
      const patch: store.ItemPatch = {};
      const changed: string[] = [];
      if (title !== undefined) {
        patch.title = title;
        changed.push("title");
      }
      if (summary !== undefined) {
        patch.summary = summary;
        changed.push("summary");
      }
      if (changes !== undefined) {
        patch.changes = JSON.stringify(changes);
        changed.push("changes");
      }
      if (linear_key !== undefined) {
        patch.linear_key = linear_key;
        changed.push("linear_key");
      }
      if (silo !== undefined) {
        patch.silo = silo;
        changed.push("silo");
      }
      if (repo_order !== undefined) {
        patch.repo_order = JSON.stringify(repo_order);
        changed.push("repo_order");
      }
      if (project !== undefined) return err("project cannot be changed after creation.");
      if (changed.length === 0) return err("Nothing to update.");

      const item = store.updateItem(db, item_id, patch);
      store.addEvent(db, item_id, "mcp", `updated ${changed.join(", ")}`);
      return itemJson(db, cfg, item);
    },
  );

  server.registerTool(
    "shipboard_link_pr",
    {
      title: "Link a PR to a work item",
      description:
        "Attach an open PR to an item, by number or head branch, so its review/merge/deploy state rolls up. " +
        "Call it right after opening a PR. Syncs that repo once if the PR is not in the store yet.",
      inputSchema: {
        item_id: itemId,
        repo: repoField,
        cwd: cwdField,
        number: z.number().int().positive().optional().describe("PR number; or pass branch"),
        branch: z.string().min(1).optional().describe("head branch; or pass number"),
      },
    },
    async ({ item_id, repo, cwd, number, branch }) => {
      const item = store.getItem(db, item_id);
      if (!item) return err(`No item #${item_id}.`);
      if ((number === undefined) === (branch === undefined)) {
        return err("Pass exactly one of number or branch.");
      }
      const resolved = resolveRepoKey(cfg, { repo, cwd });
      if ("error" in resolved) return err(resolved.error);
      const key = resolved.key;

      // Exactly one of number/branch is set, checked above.
      const find = (): PrRow | undefined =>
        number !== undefined ? store.findPr(db, key, number) : store.findPrByBranch(db, key, branch!);

      let pr = find();
      if (!pr) {
        await syncAll(db, cfg, { repos: [key] });
        pr = find();
      }
      if (!pr) {
        const what = number !== undefined ? `#${number}` : `for branch ${branch}`;
        return err(`No PR ${what} in ${key} after sync; is it opened?`);
      }
      store.linkPr(db, item_id, pr.id);
      return itemJson(db, cfg, item);
    },
  );

  server.registerTool(
    "shipboard_set",
    {
      title: "Set tracker-owned item fields",
      description:
        "Edit the fields GitHub cannot know: stage override, blocker, merge order, Linear key, and the manual " +
        "production deploy assertion. Pass null to clear a field. Use it to record a blocker or a prod deploy.",
      inputSchema: {
        item_id: itemId,
        stage_override: z
          .enum(ITEM_STAGES)
          .nullable()
          .optional()
          .describe("force the item stage; null derives it again"),
        blocked_reason: z.string().min(1).nullable().optional().describe("null unblocks"),
        repo_order: z.array(z.string().min(1)).nullable().optional().describe("required merge order"),
        prod_deployed: z.boolean().optional().describe("true asserts a production deploy now, false clears it"),
        title: z.string().min(1).optional(),
        summary: z.string().min(1).optional(),
        linear_key: z.string().min(1).nullable().optional(),
        silo: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("worktree silo (feature directory); null detaches the item from it"),
      },
    },
    ({
      item_id,
      stage_override,
      blocked_reason,
      repo_order,
      prod_deployed,
      title,
      summary,
      linear_key,
      silo,
    }) => {
      if (!store.getItem(db, item_id)) return err(`No item #${item_id}.`);
      const patch: store.ItemPatch = {};
      const changed: string[] = [];

      if (stage_override !== undefined) {
        patch.stage_override = stage_override;
        changed.push(stage_override === null ? "cleared stage override" : `stage=${stage_override}`);
      }
      if (blocked_reason !== undefined) {
        patch.blocked_reason = blocked_reason;
        changed.push(blocked_reason === null ? "unblocked" : `blocked: ${blocked_reason}`);
      }
      if (repo_order !== undefined) {
        patch.repo_order = repo_order === null ? null : JSON.stringify(repo_order);
        changed.push(repo_order === null ? "cleared repo_order" : `order=${repo_order.join(" → ")}`);
      }
      if (prod_deployed !== undefined) {
        patch.prod_deployed_at = prod_deployed ? nowIso() : null;
        changed.push(prod_deployed ? "deployed to prod" : "cleared prod deploy");
      }
      if (title !== undefined) {
        patch.title = title;
        changed.push(`title=${title}`);
      }
      if (summary !== undefined) {
        patch.summary = summary;
        changed.push("summary");
      }
      if (linear_key !== undefined) {
        patch.linear_key = linear_key;
        changed.push(linear_key === null ? "cleared linear_key" : `linear=${linear_key}`);
      }
      if (silo !== undefined) {
        patch.silo = silo;
        changed.push(silo === null ? "cleared silo" : `silo=${silo}`);
      }
      if (changed.length === 0) return err("Nothing to set.");

      const item = store.updateItem(db, item_id, patch);
      store.addEvent(db, item_id, "mcp", `set ${changed.join(", ")}`);
      return itemJson(db, cfg, item);
    },
  );

  server.registerTool(
    "shipboard_worktrees",
    {
      title: "List local worktrees",
      description:
        "Every local worktree sync has seen, with its derived stage (local-only, needs-pr, has-pr, empty, merged). " +
        "`untracked` is work no item covers — local commits that will be forgotten otherwise, so create an item for " +
        "them; `housekeeping` contains cleanup candidates from the last scan. Use remove_command: it selects the owning checkout with git -C and is independent of your current directory. If null, no removal is suggested. Recheck local changes before removal; never force removal. Unknown observations are not cleanup candidates.",
      inputSchema: {
        project: z.string().min(1).optional().describe("limit to one configured project"),
        silo: z.string().min(1).optional().describe("limit to one silo (feature directory name)"),
      },
    },
    ({ project, silo }) => {
      const inScope = (v: WorktreeView): boolean =>
        (project === undefined || projectForRepo(cfg, v.wt.repo) === project) &&
        (silo === undefined || v.wt.silo === silo);
      const opts: CollectOptions = project === undefined ? {} : { project };
      const sections = collect(db, cfg, opts);
      return ok({
        worktrees: worktreeViews(db, cfg).filter(inScope).map(jsonWorktree),
        untracked: sections.worktrees.untracked.filter(inScope).map(jsonWorktree),
        housekeeping: sections.worktrees.housekeeping.filter(inScope).map(jsonWorktree),
      });
    },
  );

  server.registerTool(
    "shipboard_add_task",
    {
      title: "Add a task to a work item",
      description:
        "Record a chore the code alone does not capture: the dev test gate, a flag flip, an env var, a migration, " +
        "a changelog or help_bot entry. Add one the moment a change creates that dependency.",
      inputSchema: {
        item_id: itemId,
        kind: z.enum(TASK_KINDS),
        text: z.string().min(1).describe("what has to be done, imperative"),
      },
    },
    ({ item_id, kind, text }) => {
      if (!store.getItem(db, item_id)) return err(`No item #${item_id}.`);
      const task = store.addTask(db, item_id, kind, text);
      store.addEvent(db, item_id, "mcp", `task ${task.kind}: ${task.text}`);
      return ok(task);
    },
  );

  server.registerTool(
    "shipboard_complete_task",
    {
      title: "Complete a task",
      description:
        "Mark a task done. Completing a `test` task is what moves an item out of needs-testing, so call it as soon " +
        "as you have verified the change on dev.",
      inputSchema: { task_id: z.number().int().positive() },
    },
    ({ task_id }) => {
      if (!store.getTask(db, task_id)) return err(`No task ${task_id}.`);
      const task = store.completeTask(db, task_id);
      store.addEvent(db, task.item_id, "mcp", `done ${task.kind}: ${task.text}`);
      return ok(task);
    },
  );

  server.registerTool(
    "shipboard_note",
    {
      title: "Note on an item's timeline",
      description:
        "Append a free-form note to an item's event timeline. Use it for anything worth remembering that is not a " +
        "field or a task — a decision, a gotcha, a manual step you took.",
      inputSchema: { item_id: itemId, text: z.string().min(1) },
    },
    ({ item_id, text }) => {
      if (!store.getItem(db, item_id)) return err(`No item #${item_id}.`);
      return ok(store.addEvent(db, item_id, "mcp", text));
    },
  );

  server.registerTool(
    "shipboard_sync",
    {
      title: "Sync from GitHub",
      description:
        "Poll GitHub via the gh CLI and refresh PR review rounds, unresolved bot threads, CI and merge state. " +
        "Takes 5-30 s, so call it once after pushing, merging or addressing review comments — not speculatively.",
      inputSchema: { repo: repoField, cwd: cwdField },
    },
    async ({ repo, cwd }) => {
      if (repo === undefined && cwd === undefined) return ok(await syncAll(db, cfg));
      const resolved = resolveRepoKey(cfg, { repo, cwd });
      if ("error" in resolved) return err(resolved.error);
      return ok(await syncAll(db, cfg, { repos: [resolved.key] }));
    },
  );

  server.registerTool(
    "shipboard_lookup_branch",
    {
      title: "Look up a branch",
      description:
        "Find the PR for a head branch and the work item tracking it, if any. Call it when you start working in a " +
        "checkout to see whether the current branch already has an item.",
      inputSchema: { branch: z.string().min(1), repo: repoField, cwd: cwdField },
    },
    ({ branch, repo, cwd }) => {
      const resolved = resolveRepoKey(cfg, { repo, cwd });
      if ("error" in resolved) return err(resolved.error);
      const hit = lookupBranch(db, cfg, resolved.key, branch);
      if (!hit) return ok({ pr: null, item: null });
      return ok({ pr: jsonPr(hit.pr), item: hit.item ? jsonItem(hit.item) : null });
    },
  );

  return server;
}

// ---------- entry point ----------

// realpath so a symlinked bin (npm link) still counts as direct invocation.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const server = createServer(openDb(), loadConfig());
  await server.connect(new StdioServerTransport());
}

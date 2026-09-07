# Pipeline tracker ("Shipboard") — design

**Scope:** a local, cross-project delivery tracker.

These notes record the original design and subsequent implementation decisions.
Later implementation notes supersede earlier plans. Start with the
[README](../README.md) for installation and [configuration](configuration.md) for
current defaults and supported workflows.

## Problem

Writing code is no longer the bottleneck. The bottleneck is knowing, for every
in-flight piece of work across every repo: what it is, which PRs belong to it,
whether the review bots have been addressed, whether it is merged, whether it
is deployed, whether it has been tested, and what post-deploy chores remain.
Today that state lives in heads, memory files ("PR API #305 first then web
#357"), and open GitHub tabs.

## Example pipeline

A feature spans an API, a web app, and sometimes a mobile app. Feature PRs target
`develop`, configured bots review each pushed revision, and a release PR carries
verified changes to `main`. A single-branch app can target `main` directly.
Projects configure their own branch names, review bots, and deployment mode.
GitHub CLI supplies repository access; optional EAS integration observes OTA
updates. The tracker groups the work and records merge dependencies and tasks
that GitHub cannot infer.

## Design principle

**Derive everything GitHub already knows; store only what it cannot.**
A tracker that has to be hand-updated becomes a second Linear and rots. So:

| Derived from GitHub (polled, never hand-edited) | Stored in the tracker (authored by Claude or you) |
|---|---|
| branch exists, commits ahead of base | the **work item** grouping PRs across repos |
| PR open / draft / base / merged / closed | one-paragraph summary + "what changed" bullets |
| review round number (distinct head SHAs that received bot reviews) | required merge/deploy order between repos |
| unresolved bot review threads on current head | tested-on-dev result (pass / fail + note) |
| CI check status | post-deploy tasks: flag flip, env var, migration, changelog, help_bot |
| merged into `develop` / included in an open release PR / merged into `main` | blockers and free-form notes |
| | deployed-where for things GitHub can't see (EAS OTA, manual deploys) |
| | optional Linear issue link |

## Data model (SQLite, `~/.shipboard/shipboard.db`)

```
projects        id, name, repos(json: [{owner, name, dev_branch, prod_branch, deploy: "auto"|"manual"}])
items           id, project_id, title, summary, changes(json), linear_key,
                stage_override, blocked_reason, created_at, updated_at, archived_at
prs             id, item_id, repo, number, head_branch, base_branch, head_sha,
                state, is_draft, review_round, unresolved_bot_threads,
                bot_reviews_on_head(bool), ci_state, merged_at,
                in_release_pr(number|null), on_dev(bool), on_prod(bool), synced_at
tasks           id, item_id, kind(test|flag|env|migration|changelog|helpbot|other),
                text, done_at
events          id, item_id, at, source(hook|mcp|sync|user), text
```

Merge order is `items.repo_order` (json list); the dashboard warns when a later
repo's PR is ready to merge before an earlier repo's PR has merged.

## Stage model

Per-PR stage is fully derived:

```
drafting         branch/draft, no ready PR
awaiting-review  ready PR, no bot review on current head
needs-addressing unresolved bot threads on current head          → agent can act
awaiting-re-review  pushed since last round, bots not yet re-reviewed
ready-to-merge   0 unresolved threads, bots reviewed head, CI green → human decision
merged-develop   merged, base = develop
in-release       commit reachable from an open develop→main PR head
merged-main      commit reachable from main (prod deploy pending)
```

Item stage = the *least advanced* of its PRs, unless `stage_override` is set,
and with two tracker-owned stages layered on:

```
needs-testing    all PRs merged-develop (and on dev) and no passing test task
tested           test task done
needs-prod-deploy  merged-main, prod deploy not yet asserted
needs-post-deploy  deployment confirmed but verification or tasks remain
done             deployment confirmed, current tests passed, no open tasks
blocked          blocked_reason set
```

When all active PRs reach the production branch, the item advances to
`needs-prod-deploy` even without passing test evidence. After deployment is
confirmed, outstanding verification keeps it in `needs-post-deploy`. Missing
test evidence remains an independent next action; it does not move released work
back into develop. The PR's `on_prod` flag records production branch membership,
not a deployment confirmation. Historical CI failures on merged PRs do not gate
these stages.

The dashboard's primary view is not the board but the **attention queue**:
everything in `needs-addressing`, `ready-to-merge`, `needs-testing`,
`needs-release` (tested items sitting in develop with no release PR),
`needs-post-deploy`, and `blocked`, grouped by whether an agent or you must act.

## Components

One TypeScript package, three entry points over the same SQLite store.

1. **`shipboard` CLI** — `sync [--repo]`, `ls [--attention]`, `show <id>`,
   `serve`. Used by hooks, cron, and you.
2. **MCP server** (stdio, registered globally in `~/.claude.json`) — tools:
   - `shipboard_list(filter)` / `shipboard_get(id)`
   - `shipboard_upsert_item({title, summary, changes, project, linear_key})`
   - `shipboard_link_pr({item_id, repo, number})` (or by branch name)
   - `shipboard_set({item_id, stage_override?, blocked_reason?, repo_order?})`
   - `shipboard_add_task` / `shipboard_complete_task`
   - `shipboard_note({item_id, text})`
   - `shipboard_sync({repo?})`
3. **Sync engine** — for each registered repo, one GraphQL call via
   `gh api graphql` fetching open + recently merged PRs with `reviews {commit.oid,
   author}`, `reviewThreads {isResolved, comments(first:1){author}}`,
   `commits(last:1){statusCheckRollup}`, `mergedAt`, `baseRefName`.
   Then `git`/`gh` checks for reachability from `develop` / `main` and
   membership in the open release PR. Gating bot logins are config; initially
   `coderabbitai` and `qodo-code-review` only. Dev deploy state = reachability
   from `develop`. Prod deploy is asserted, not derived: `shipboard deployed
   <item> prod` or the `shipboard_set` MCP tool, since prod is a manual step.
   For the tenant app, `eas update:list --json` maps OTA groups to commits.
4. **Dashboard** — `shipboard serve` on localhost. Attention queue at the top,
   Kanban by item stage below, project filter, item drawer (summary, PRs with
   round/threads/CI badges, merge-order warning, tasks, event timeline).
   Server-rendered HTML + a little JS; no build step.

## Claude automation

The point is that Claude keeps this current without being asked.

- **PostToolUse hook on Bash** (global `settings.json`): a script reads the
  tool input; if the command matches `git push`, `gh pr create|merge|ready`,
  `eas update|build`, or `gh pr comment` from the address-comments flow, it runs
  `shipboard sync --repo <cwd>` and returns `additionalContext`:
  - branch has no item → "Tracker: no work item for `feature/x`. Call
    `shipboard_upsert_item` with a title, summary and change list, then
    `shipboard_link_pr`."
  - item exists → "Tracker: item #12 now `awaiting-re-review` (round 2)."
  Detection is deterministic; the narrative (summary, change list, tasks) is
  authored by Claude through the MCP tools.
- **Global CLAUDE.md rule**: on PR creation link or create an item; when a
  feature adds a flag, env var, migration, changelog or help_bot dependency,
  add a task; at the end of `/address-pr-comments` call `shipboard_sync`.
- **`/address-pr-comments` skill**: one added final step — `shipboard_sync`.
- **Cron / launchd** every 10 min: `shipboard sync` so bot reviews landing
  while no session is open still show up.
- **SessionStart hook** (opt-in per project): inject the attention queue for
  that project, capped at ~10 lines, only when non-empty.
- **Memory**: pipeline-status memories ("PR API #305 first then web #357")
  stop being written; the tracker owns that. Memory keeps design decisions.

## Phases

| Phase | Deliverable | Effort |
|---|---|---|
| 0 | Repo, schema, `shipboard sync` + `ls --attention` from GitHub; group related open PRs into work items | ~half day |
| 1 | MCP server, PostToolUse hook, CLAUDE.md rule, address-pr-comments hook-in | ~half day |
| 2 | Dashboard (`shipboard serve`) | ~1 day |
| 3 | EAS OTA detection, SessionStart digest, Linear link, 10-min cron | as needed |

Phase 0 alone is useful: one command that prints every open PR across every
repo with its round, unresolved bot threads, CI, and where it has landed.

## Decisions (settled 2026-09-03)

- **Deploys:** the original workflow assumed dev auto-deploys and manual prod
  deploys. Configuration selects branch names and manual or automatic production
  semantics; dev availability is inferred from branch membership.
- **Gating bots:** CodeRabbit and Qodo only. CodeAnt and the Codex connector
  are ignored until configured otherwise.
- **Storage:** local SQLite, single machine. Hosted read-only copy is a
  possible later phase.
- **Linear:** optional link per item, no two-way sync.

## Implementation notes (Phase 0, 2026-09-03)

Deviations from the design above, settled during implementation:

- **Projects live in `~/.shipboard/config.json`, not a `projects` table.** A
  hand-editable file is the right home for repo lists, gating bots and ignored
  authors; `items.project` holds the project name. First run writes an empty
  project list; users configure their own repositories.
- **No local clones.** Everything comes from `gh api`: one GraphQL query per repo
  (50 open + 30 recently merged PRs) and REST `compare/{branch}...{sha}` for
  reachability (`ahead_by == 0` means the commit is in the branch). Linked PRs
  that age out of the batch are refetched individually so they never go stale.
- **Extra PR stages `ci-failing` and `awaiting-ci`** so a red or pending CI has
  somewhere to go; `ci-failing` is agent-actionable. Null CI (no checks
  reported) is treated as green.
- **`needs-release`** is an item stage: tested, all PRs merged to develop, no
  open release PR contains them.
- **Prod deploy is asserted** via `shipboard deployed <item> prod`, stored as
  `items.prod_deployed_at`. `prs.on_prod` (derived from `main`) drives the
  `merged-main` PR stage; `merged-main` PRs may legitimately have `on_dev = 0`
  (a release PR's merge commit exists only on `main`).
- **Outdated review threads do not gate.** `unresolved_bot_threads` counts only
  threads that are neither resolved nor outdated.
- **Review round** = distinct head SHAs reviewed by any gating bot (union, not
  per-bot).
- **Tenant app** is configured with `dev_branch = prod_branch = main`, so its
  PRs go straight to `merged-main` and there is no release step.
- Tooling: TypeScript (ESM, `tsc` → `dist/`), `better-sqlite3`, `commander`,
  `vitest`. Node 22.12+.

## Implementation notes (Phase 1, 2026-09-03)

- **MCP server** `dist/mcp.js` (bin `shipboard-mcp`), registered in
  `~/.claude.json` as `shipboard`. Tools: `shipboard_list`, `shipboard_get`,
  `shipboard_upsert_item`, `shipboard_link_pr` (syncs the repo once if the PR
  is not stored yet), `shipboard_set` (null clears; `prod_deployed: true`
  asserts a prod deploy), `shipboard_add_task`, `shipboard_complete_task`,
  `shipboard_note`, `shipboard_sync`, plus `shipboard_lookup_branch` (not in the
  original list; answers "does this branch already have an item?"). Repo
  arguments accept `repo: "owner/name"` or `cwd: <checkout path>`.
- **PostToolUse hook** `dist/hook.js` (bin `shipboard-hook`), registered in
  `~/.claude/settings.json` with matcher `Bash`, 50 s timeout. Fires on
  `git push`, `gh pr create|merge|ready|comment`, `gh api …/pulls/N/…` replies
  and `eas update|build`; syncs only the repo of the cwd (or of `git -C` /
  leading `cd`), then returns `additionalContext` naming the item and its new
  stage, merge-order warnings and a one-line hint, or the instruction to create
  and link an item. Silent for unlinked release PRs, for commands outside a
  configured repo, and on any error. Set `SHIPBOARD_HOOK_DEBUG=1` to see errors.
- **Shared read models** live in `src/views.ts`; CLI, MCP server and hook all
  render from the same `ItemView`/`PrView` and `collect()`.
- **Agent workflow** is documented in [agent-workflow.md](agent-workflow.md),
  with setup for Claude Code and Codex in [agents.md](agents.md).

## Implementation notes (Phase 2, 2026-09-03)

- **`shipboard serve [--port 7373] [--host 127.0.0.1] [--open]`** runs a
  `node:http` server (`src/server.ts`) that renders HTML from `src/web/` and
  reads the same view models as the CLI and MCP server. Routes: `GET /`
  (`?project=`), `GET /item/:id` (drawer fragment), `GET /api/board`,
  `GET /api/items/:id`, `POST /sync`, `POST /tasks/:id/done`,
  `POST /items/:id/archive`, `POST /items/:id/deployed`. Defaults to loopback,
  no auth. Intended for local use; the default port is 7373.
- **Board columns** group item stages: Drafting · In review (awaiting-*,
  needs-addressing, ci-failing) · Ready to merge · In develop (merged-develop,
  needs-testing, tested, needs-release) · In release · On main (merged-main,
  needs-prod-deploy) · Post-deploy · Done. Blocked items sit in "In review"
  with a red badge because their true column would need the PR state.
- **Client JS** is ~90 lines: drawer open/close with `#item-N` hash, Sync
  button, task-done / deployed / archive actions via `data-` attributes, page
  auto-reload every 2 minutes while no drawer is open. No inline handlers, no
  external assets, light/dark via `prefers-color-scheme`.

## Implementation notes (Phase 3, 2026-09-03)

- **EAS OTA detection.** Repos with `eas: { cwd, branch }` in config get their
  update groups cached in `ota_updates` (`eas update:list` for the group ids,
  `eas update:view` once per unseen group for the git commit). A merged PR's
  `deployed_at`/`deploy_ref` is the oldest update on that branch whose commit
  contains the merge commit, found with the same REST compare as reachability.
  Shipping is monotonic. Item rule: `needs-prod-deploy` clears when
  `prod_deployed_at` is asserted **or** every PR has `deployed_at`. Only the
  last 20 groups are consulted, so very old merges attribute to the oldest
  cached group.
- **SessionStart digest.** The same hook binary handles
  `hook_event_name: "SessionStart"`: for a cwd inside a configured repo it
  prints that project's attention queue (≤10 lines, no sync, with the last sync
  age). Unconfigured cwd → silent; that is the per-project opt-in.
- **Linear links.** `linear_workspace` in config (`my-team`) turns
  `items.linear_key` into `https://linear.app/<ws>/issue/<KEY>` in the
  dashboard and `show`. No API calls, no two-way sync.
- **Cron.** `shipboard cron install [--interval 600] | uninstall | status`
  writes `~/Library/LaunchAgents/dev.shipboard.sync.plist` running
  `node dist/cli.js sync` with the current PATH (so `gh` and `eas` resolve),
  logging to `~/.shipboard/sync.log`, and bootstraps it into `gui/<uid>`.

## Implementation notes (Phase 4, 2026-09-03) — worktrees and silos

- **Why.** Work lives in silos (`~/Projects/example-features/<silo>/<repo>`,
  one worktree per repo) and branches get forgotten before they reach GitHub.
  The tracker now derives local state the same way it derives PR state.
- **Derived.** For repos with `local` in config, sync runs `git fetch` then
  `git worktree list --porcelain` in the main checkout and, per worktree:
  ahead-of-dev (`origin/<dev>..HEAD`), on-origin, unpushed
  (`HEAD ^origin/<dev> ^origin/<branch>`, so a rebased branch reports its real
  count), dirty, last commit. Rows live in `worktrees`; vanished paths are
  deleted. Silo = parent dir name when the leaf is the repo checkout name,
  else the leaf.
- **Stages.** Worktree: `local-only` (unpushed commits, no PR), `needs-pr`
  (pushed, ahead of dev, no PR), `has-pr`, `empty`, `merged`. Item stages
  `local-only` (rank −2) and `needs-pr` (−1) sit below `drafting`; both are
  agent-actionable. `local-only` on any attached worktree wins outright;
  `needs-pr` only surfaces when no PR of the item still needs attention.
- **Linking.** A worktree belongs to an item when its branch has a PR linked
  to the item, or when `items.silo` equals the worktree's silo
  (`shipboard link <item> silo:<name>`, `item add --silo`, MCP `silo`).
- **Surfaces.** Attention queue gains "Forgotten local work" (untracked
  `local-only`, oldest first); `ls`/dashboard gain "Untracked worktrees" and
  "Worktrees to clean up" (`empty`/`merged`, with the `git worktree remove`
  command); board gets a "Local" column; drawer/`show` list worktrees; MCP
  `shipboard_worktrees`; SessionStart digest adds a `forgotten:` line; the
  push hook says when a pushed branch has no PR.


## Implementation notes (2026-09-05) — trust and next actions

This increment updates the earlier stage and confirmation rules:

- **Local work is independent of PR status.** Dirty or unpushed changes remain
  `local-only` with open, closed, or merged PRs. A closed PR does not cover a
  proposal, and a merged PR only covers its recorded head. Failed status/count
  observations use `unknown`; unreadable listed worktrees remain visible. Failed
  fetches or listings withdraw prior cleanup evidence. Unknown counts are stored
  as `-1`, never displayed as zero or treated as clean.
  Main checkouts with local changes or unknown observations are visible; clean
  main checkouts never enter housekeeping.
- **Confirmations cover commits.** Test completions and manual production
  assertions snapshot the full active linked PR set, including head and merge
  SHAs. All test tasks must have current evidence. Commit changes and linking or
  removing PRs invalidate prior confirmations. Historical timestamps are retained;
  legacy evidence needs reconfirmation through the drawer, CLI, or existing MCP
  completion/deployment tools. Automatic cached deployment evidence remains a
  separate production signal.
  Browser test/deploy confirmation requests carry the rendered fingerprint in
  `expected_evidence`; comparison and recording happen in one SQLite transaction.
  Changed or missing fingerprints return HTTP 409 without recording confirmation.
- **Source health is explicit.** `sync_health` stores per-repository GitHub, EAS,
  and worktree attempts, successes, and errors. Configured sources with no record
  appear as `never`; observations older than 30 minutes are `stale`. Independent
  sync sources still run when another fails. Dashboard/API, CLI, MCP, and the
  SessionStart digest expose health rather than inferring it from the newest PR.
  Project scoping covers unlinked PRs, releases, worktrees, and health too.
- **Actions are separate from lifecycle.** `src/actions.ts` derives a ranked
  queue across PRs, worktrees, and item tasks. CI failure can surface while an
  item is drafting; merge prerequisites remain visible. Priority is deterministic
  with human-readable reasons, not an AI score or waiting-time metric. The
  dashboard shows the next three actions; `shipboard next` and `shipboard_next`
  accept project/limit filters. `GET /api/next` returns actions and source health.
- **Resume is a cached briefing.** `src/resume.ts`, `shipboard resume <item>`,
  and MCP `shipboard_resume {item_id}` assemble objective, actions, paths, commits,
  tasks, recent context, confirmation status, and freshness. The drawer links to
  `GET /api/items/:id/resume?format=text`; omitting `format` returns JSON. These
  interfaces neither sync nor execute suggested actions and do not invoke an LLM.

Snoozes, read receipts, a change inbox, new scheduled digests, AI-generated
analysis, and agent launching/automatic dispatch remain future work. The existing
SessionStart digest now includes independent actions and unhealthy sources even
when no action is present in the cache. Verification uses synthetic fixtures
and injected clients.

## Dashboard worktree removal (2026-09-05)

Cleanup suggestions select their configured owning repository with `git -C` and
quote both absolute paths. `main_checkout` and `remove_command` are included in
worktree JSON; an unavailable or unsafe command is null.

The dashboard confirms the exact path before `POST /worktrees/remove` with
`path` and `expected_head`. This endpoint requires a per-server page token and
loopback origin/Host, serializes requests for the same path, and refuses overlap
with dashboard sync. An injectable Git client verifies registration, lock state,
HEAD, local branch preservation, working files, and counts against locally
cached remote refs, then repeats identity/status checks immediately before
`git -C <main> worktree remove -- <path>`. It never fetches, forces removal, or
deletes the branch. Ignored files inside the checkout are deleted, as disclosed
in confirmation. Failed checks retain the cache entry; success removes it and
records an event for linked work items. Validation uses fake Git and browser
clients; no real worktrees are removed during testing.

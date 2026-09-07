# Configuration

Shipboard loads `~/.shipboard/config.json`, or `$SHIPBOARD_HOME/config.json`
when overridden. Use `project add` for initial setup and additional repositories;
edit the JSON for optional integrations or changes to an existing registration.
Restart long-running MCP and dashboard processes after configuration changes.

## Add a project or repository

```sh
# From inside the repository you want to track:
shipboard project add my-project

# From any directory, including the Shipboard checkout:
shipboard project add my-project --local /absolute/path/to/your-repo

# Without local worktree tracking:
shipboard project add my-project --repo your-org/your-repo \
  --dev-branch develop --prod-branch main --deploy manual
```

The project is created if needed. Add another repository to it by repeating the
command with the same project name. The command writes configuration only: it
does not create an item, fetch, sync, or open the database.

| Option | Behavior |
| --- | --- |
| `<name>` | Required project name; quote names containing spaces. |
| `--local <path>` | Inspect this checkout's GitHub `origin` and enable worktree tracking. Subdirectories and linked worktrees resolve to the main checkout. |
| `--repo <owner/name>` | Register a GitHub repo without local tracking. With `--local`, it must match that checkout's origin. |
| `--prod-branch <branch>` | Override production branch detection. |
| `--dev-branch <branch>` | Override development branch detection. |
| `--deploy manual\|auto` | Production deployment mode; defaults to `manual`. |

With neither `--repo` nor `--local`, discovery uses the current directory. A local
checkout needs a GitHub `origin` remote. Production defaults to cached
`origin/HEAD`, then a known `main` or `master` branch, then `main`. Development
uses a known `develop` branch, otherwise production. Known branches include local
branches and cached `origin` refs; no network request is made. For `--repo` alone,
both branches default to `main`. Explicit branch names are checked for Git syntax
but are not required to exist yet. Always check the printed configuration for
projects with different branch or deployment conventions.

The command preserves existing project and integration settings, including
unrecognized fields. It refuses duplicate repositories (case-insensitively), even
across projects, and leaves malformed configuration untouched. To update or move
a registered repo, edit its existing JSON entry. Concurrent `project add` writers
are guarded by a `config.json.lock` file and atomic file replacement. If a command
was interrupted and left a stale lock, remove it only after confirming no other
project command is running.

After adding repositories:

```sh
shipboard sync --repo your-org/your-repo
```

## Edit configuration manually

Start with [the example config](../examples/config.json). The file is JSON,
without comments or trailing commas. Ordinary first-run reads create an empty
project list; `project add` can create the file with its first configured project.

## Fields

| Field | Meaning |
| --- | --- |
| `projects` | Named groups of repositories. One item can span several repos. |
| `projects[].name` | Project name used by CLI/MCP filters and work items. |
| `projects[].repos[].owner` | GitHub owner or organization. |
| `projects[].repos[].name` | GitHub repository name, without the owner. |
| `dev_branch` | Development branch; membership is treated as reaching dev. |
| `prod_branch` | Production branch; membership is separate from manual deployment evidence. |
| `deploy` | `manual` requires deployment confirmation or EAS evidence; `auto` treats production branch membership as deployed. |
| `local` | Optional main checkout path. Enables fetching and worktree discovery. |
| `eas` | Optional `{ "cwd": "/path/to/app", "branch": "production" }` for EAS Update detection. |
| `gating_bots` | Review bot GitHub logins without `[bot]`. Defaults to `coderabbitai` and `qodo-code-review`. |
| `ignored_authors` | PR authors hidden in default listings. Defaults to `dependabot`; `ls --all` includes them. |
| `linear_workspace` | Optional workspace slug for clickable issue keys. No Linear API connection. |

Repo fields belong inside each `projects[].repos[]` entry. `gating_bots`,
`ignored_authors`, and `linear_workspace` are top-level fields. Use absolute paths
for `local` and `eas.cwd`; leading `~/` is also supported there.

## Pipeline assumptions

For `feature → develop → main`, use `dev_branch: "develop"` and
`prod_branch: "main"`. For direct-to-main projects, set both to `main`.
Shipboard infers dev availability from branch reachability; it does not query
your hosting provider to verify a dev deployment.

Choose `deploy: "auto"` only when reaching the production branch is sufficient
for your workflow to consider the change deployed. Otherwise use `manual` and
record confirmation after checking the actual deployment. EAS Update commit
ancestry can also provide deployment evidence for configured Expo projects;
EAS builds alone are not proof of deployment.

The current review model gates on configured bots. Human approvals are not a
replacement gate, and an empty `gating_bots` list does not disable the review
stage: open, non-draft PRs without a qualifying review remain `awaiting-review`.
Configure bots you actually use. A missing CI rollup is treated as no checks
reported, rather than a failure.

GitHub sync fetches up to 50 open and 30 recently updated merged PRs per repo,
with up to 100 reviews and 100 review threads per PR. Linked PRs outside the
batch are fetched individually. Full pagination is not implemented, so large
repositories or long review histories can exceed these windows.

## Multiple repositories and local work

Repeat `project add` with the same name to track a backend, frontend, or mobile
app together. Use another project name to keep an unrelated product's queue separate. Use
`--order your-org/api,your-org/web` when creating an item only when those repos
have a real merge dependency.

A configured `local` checkout allows Shipboard to discover its Git worktrees,
fetch remote refs, and record dirty/unpushed work. It does not create worktrees.
A *silo* groups related worktrees by directory name; see [usage](usage.md) for
cleanup and resumption behavior. Without `local`, GitHub tracking still works.

## Optional services

- **EAS:** install and authenticate the `eas` CLI separately, then set `eas.cwd`
  to an Expo checkout and `eas.branch` to the branch reaching users. Sync reads
  the latest 20 update groups and resolves their commits.
- **Linear:** set `linear_workspace` and attach a key with `--linear APP-42`.
  This creates links only.
- **Scheduled sync on macOS:** `shipboard cron install --interval 600`,
  `shipboard cron status`, and `shipboard cron uninstall` manage a user
  LaunchAgent. It captures the installation environment's PATH. Reinstall it
  after moving Shipboard or changing the Node/CLI paths. Use your OS scheduler
  on other platforms.

## Storage and troubleshooting

| Setting | Default |
| --- | --- |
| `SHIPBOARD_HOME` | `~/.shipboard` (config, database, sync log) |
| `SHIPBOARD_DB` | `<SHIPBOARD_HOME>/shipboard.db` |
| CLI `--db /path/to/file.db` | Overrides `SHIPBOARD_DB` for that invocation |
| `SHIPBOARD_EAS_BIN` | `eas` (override with an absolute executable path) |
| `SHIPBOARD_SERVE_DEBUG=1` | Log dashboard request failures to stderr |
| `SHIPBOARD_HOOK_DEBUG=1` | Log hook errors to stderr |

Use the same data-directory overrides for the CLI, dashboard, and both agents
when they should share state. The built-in LaunchAgent is intended for the default
profile; for custom profiles, configure those environment variables in your own
scheduler. Stop all Shipboard processes before copying the data directory as a
backup, including SQLite sidecar files if present.

If the board is empty, check that `projects` contains your repo, run
`gh auth status`, then `shipboard sync --repo your-org/your-repo`. `next` and
`resume` read cached observations and never sync implicitly. Inspect source health
for errors; observations older than 30 minutes are marked stale.

If installation fails in `better-sqlite3`, confirm Node meets the engine
requirement. When a prebuilt native module is unavailable, compilation requires
Python and a C/C++ build toolchain (for example Xcode Command Line Tools on macOS).
After switching Node versions, reinstall dependencies with `npm ci`.

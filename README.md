# Shipboard

**Know what needs to happen next across your repositories.**

Shipboard is a local delivery tracker for developers working with coding agents.
It connects related pull requests into one work item and follows them from local
changes through review, merge, deployment, and testing. A CLI, browser dashboard,
and MCP server share the same SQLite database, so Claude Code and Codex can pick
up where you left off.

Shipboard derives what it can from GitHub. You and your agents add the context
GitHub doesn't have: the objective, merge dependencies, verification, and release
chores.

- **One feature, several repos:** group PRs and record the order they need to merge.
- **A next-action queue:** surface review feedback, failing CI, unpushed work,
  and outstanding tasks with reasons for each suggestion.
- **Portable handoffs:** resume with the objective, worktree paths, commits,
  recent notes, and remaining actions.
- **Evidence tied to commits:** changes to linked PRs invalidate old test and
  manual deployment confirmations.
- **Local worktree tracking:** find forgotten branches and inspect cleanup candidates.

Shipboard is early-stage software. Its review pipeline currently expects
configured review bots, and its development-stage model assumes the development
branch reaches your dev environment. See [configuration](docs/configuration.md)
for the assumptions and optional integrations.

## Quickstart

### 1. Install from source

You'll need **Node.js 22.12+**, npm, Git, and an authenticated
[GitHub CLI](https://cli.github.com/) with access to the repositories you track.
macOS is the primary development platform; built-in scheduling and `--open` use
macOS utilities. On other platforms, open the dashboard URL yourself and use your
own scheduler.

Clone this repository and install from its root:

```sh
git clone https://github.com/CharlieHorton/shipboard.git
cd shipboard
npm ci
npm link
shipboard --help
gh auth status
```

`npm ci` builds the three entry points in `dist/`. `npm link` puts `shipboard`,
`shipboard-mcp`, and `shipboard-hook` on your PATH. To skip linking, use
`node /absolute/path/to/shipboard/dist/cli.js` wherever these docs say `shipboard`.
If GitHub CLI isn't signed in yet, run `gh auth login`.

### 2. Configure your repositories

Point Shipboard at a local checkout of a project you want to track:

```sh
shipboard project add my-project --local /absolute/path/to/your-repo
```

Or run `shipboard project add my-project` from inside that checkout. Shipboard
reads its GitHub `origin`, finds the main checkout, and saves the configuration
in `~/.shipboard/config.json`. It prints the selected branches and deployment
mode so you can check them. No fetch or sync runs during setup.

For an explicit development/production workflow:

```sh
shipboard project add my-project --local /absolute/path/to/your-repo \
  --dev-branch develop --prod-branch main --deploy manual
```

For GitHub tracking without a local checkout:

```sh
shipboard project add my-project --repo your-org/your-repo \
  --dev-branch develop --prod-branch main
```

Repeat with the same project name and a different repo to group related
repositories. Repeat with a new name to add another project. Existing settings
are preserved; already registered repositories are refused rather than replaced.
Restart a running dashboard or MCP server after adding repositories.

By default, production uses the cached `origin/HEAD`, then a local or cached
`main`/`master` branch, then `main`. Development uses `develop` if found, otherwise
the production branch. Deployment defaults to `manual`. With `--repo` alone,
both branches default to `main`. Override these options to match your workflow.
See [configuration](docs/configuration.md) for advanced settings and the
[example JSON](examples/config.json) for manual editing.

### 3. Sync and open the dashboard

```sh
shipboard sync
shipboard serve
```

Open **http://127.0.0.1:7373**. On macOS, `shipboard serve --open` opens it for you.
Unlinked PRs appear after syncing; create an item to group a feature's work:

```sh
shipboard item add --project my-project --title "Add search" \
  --summary "Let users search their saved documents." \
  --change "Add a search endpoint and results page"

# Use the item ID printed above and an existing PR number.
shipboard link 1 'your-org/your-repo#42'
shipboard task add 1 --kind test "Verify search on dev"
shipboard next
shipboard resume 1
```

## Connect your coding agent

Both agents use the same local stdio MCP server. Run these from the Shipboard
checkout after installation:

**Claude Code**

```sh
claude mcp add --transport stdio --scope user shipboard -- node "$PWD/dist/mcp.js"
claude mcp get shipboard
```

**Codex**

```sh
codex mcp add shipboard -- node "$PWD/dist/mcp.js"
codex mcp get shipboard
```

Start a new agent session, then ask: **“Use Shipboard to show what needs my
attention.”** Complete the [agent setup guide](docs/agents.md) to add workflow
instructions, Claude Code's optional hooks, and desktop PATH configuration.
The guide also covers other agents that support local stdio MCP servers.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `shipboard project add my-project --local /path/to/repo` | Register a repository |
| `shipboard sync --repo your-org/your-repo` | Refresh one repository |
| `shipboard ls --attention` | Show work needing attention |
| `shipboard show 1` | Inspect a work item |
| `shipboard next --project my-project --json` | Get ranked actions and source health |
| `shipboard resume 1` | Get a cached handoff briefing |
| `shipboard note 1 "Verified on dev at commit abc123"` | Record context or evidence |
| `shipboard task done 3` | Confirm task 3 after verification |
| `shipboard deployed 1 prod` | Record a verified production deployment |
| `shipboard cron install --interval 600` | Schedule sync every 10 minutes on macOS |

Run `shipboard <command> --help` for options. [Usage details](docs/usage.md) explain
source freshness, worktree removal, and when verification needs repeating.

## Data and access

Data lives in `~/.shipboard/`: `config.json`, `shipboard.db`, and optional sync
logs. `SHIPBOARD_HOME` selects another data directory; `SHIPBOARD_DB` overrides
the database path. GitHub access uses your existing `gh` authentication. Optional
EAS integration invokes your authenticated `eas` CLI. Local worktree sync runs
`git fetch` in configured checkouts.

The dashboard is intended for a single user on localhost and has no login system.
Keep its default loopback binding. MCP tools can update tracker records and run
sync; the dashboard can remove a worktree after confirmation and local checks.
It does not merge PRs or deploy applications for you. See
[the security policy](SECURITY.md) for the trust boundary and reporting guidance.

## Development and license

```sh
npm run typecheck
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and
[docs/design.md](docs/design.md) for architecture and design history.
Rebuild after pulling updates; the CLI, hooks, and MCP server run from `dist/`.

[MIT licensed](LICENSE).

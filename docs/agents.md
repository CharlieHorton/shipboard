# Coding agent setup

Shipboard exposes a local **stdio MCP server**. Install and configure Shipboard
with the [quickstart](../README.md#quickstart), then connect an agent below.
The dashboard does not need to be running for MCP to work.

## Claude Code

From the Shipboard checkout:

```sh
claude mcp add --transport stdio --scope user shipboard -- node "$PWD/dist/mcp.js"
claude mcp get shipboard
```

User scope makes it available across your projects. Start a new Claude Code
session and use `/mcp` to inspect its connection. See
[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

Add the [workflow instructions](#workflow-instructions) to `~/.claude/CLAUDE.md`
for all projects, or a project's `CLAUDE.md` for just that project.

### Optional automatic hooks

Merge this into `~/.claude/settings.json`, preserving your other settings and
hook entries. Replace `/absolute/path/to/shipboard` with your checkout path.
The escaped quotes keep paths with spaces usable.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/shipboard/dist/hook.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/shipboard/dist/hook.js\"",
            "timeout": 50
          }
        ]
      }
    ]
  }
}
```

`SessionStart` supplies a cached project digest. `PostToolUse` recognizes selected
Git/GitHub/EAS commands, syncs the configured repository, and returns context.
It is a command-pattern hook, not a general filesystem watcher. See
[Claude Code's hook reference](https://code.claude.com/docs/en/hooks) for settings
and event behavior. Run `shipboard sync` once before expecting a useful digest.

## Codex

From the Shipboard checkout:

```sh
codex mcp add shipboard -- node "$PWD/dist/mcp.js"
codex mcp get shipboard
```

Alternatively, add this to `~/.codex/config.toml` with an absolute path:

```toml
[mcp_servers.shipboard]
command = "node"
args = ["/absolute/path/to/shipboard/dist/mcp.js"]
```

These are alternative ways to configure the same server. See
[OpenAI's MCP documentation](https://developers.openai.com/codex/mcp).

Add the workflow below to `~/.codex/AGENTS.md` for all projects, or a project's
`AGENTS.md` for just that project. Start a new session to load the instructions
and server. See [OpenAI's AGENTS.md documentation](https://developers.openai.com/codex/guides/agents-md).
Shipboard's bundled hook consumes Claude Code events; this Codex setup uses MCP
and workflow instructions to trigger sync after delivery changes.

## Workflow instructions

Copy the contents of [agent-workflow.md](agent-workflow.md) into your chosen
instruction file, preserving existing instructions. To share one maintained copy
between agents, save that file in a stable local location and add a pointer to
each agent's instruction file:

```markdown
When starting or resuming repository work, creating or updating PRs, completing
reviews, or reporting release progress, read and follow
`/absolute/path/to/agent-workflow.md`. Apply it to repositories configured in
Shipboard.
```

The workflow directs agents to resume existing items, link new PRs, record
release tasks, and keep evidence current. It does not authorize a merge or deploy.

## Verify the connection

In a new session opened inside a configured repository, ask:

> Use Shipboard to list my tracked work and source health. Identify whether this
> branch has an item. Read cached data only.

Expect calls to `shipboard_list` or `shipboard_next`, then
`shipboard_lookup_branch` with the explicit repo and branch. If an item exists,
`shipboard_resume` provides its handoff. An empty result is valid before items
are created. Ask for `shipboard_sync` explicitly when you want fresh observations.

Available tools include:

- Read: `shipboard_list`, `shipboard_get`, `shipboard_lookup_branch`,
  `shipboard_worktrees`, `shipboard_next`, `shipboard_resume`.
- Record work: `shipboard_upsert_item`, `shipboard_link_pr`, `shipboard_set`,
  `shipboard_add_task`, `shipboard_complete_task`, `shipboard_note`.
- Refresh sources: `shipboard_sync`.

## Other agents

For clients supporting local stdio MCP servers, use this launch configuration
in the client's documented MCP settings:

```json
{
  "mcpServers": {
    "shipboard": {
      "command": "node",
      "args": ["/absolute/path/to/shipboard/dist/mcp.js"]
    }
  }
}
```

The surrounding JSON format varies by client. Supply the same workflow in its
instruction mechanism. Clients that only support remote HTTP MCP cannot connect
directly to this stdio server.

## Paths, profiles, and troubleshooting

- **Desktop PATH:** use `command -v node` to find your Node executable and replace
  `node` with that absolute path in the launch command/config. Ensure `gh` and
  optional `eas` are also on the server process's PATH. Restart the desktop app
  after changing its environment.
- **Different data in each agent:** both need the same `SHIPBOARD_HOME` and
  `SHIPBOARD_DB` settings. Codex accepts `--env SHIPBOARD_HOME=/absolute/path`
  before `--` in `mcp add`; other clients can set the server's environment in
  their configuration.
- **Server fails to start:** run `npm run build` and confirm `dist/mcp.js` exists.
  `node /absolute/path/to/shipboard/dist/mcp.js` waits for MCP messages on stdin;
  silence alone is normal. Inspect your client's MCP connection status and logs.
- **Hooks are silent:** hooks only apply inside a configured repository. Set
  `SHIPBOARD_HOOK_DEBUG=1` in their environment to see errors.
- **After updates:** rebuild and restart connected agent sessions. Re-register
  the server if you move the checkout.

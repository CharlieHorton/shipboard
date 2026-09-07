# Contributing to Shipboard

Bug reports, documentation improvements, and focused pull requests are welcome.
For a substantial change to the pipeline model or integrations, open an issue
first so the intended behavior can be discussed.

## Local development

Install Node.js 22.12+, npm, and Git, then run from the checkout:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm ci` also builds through the `prepare` script. Tests use synthetic fixtures,
in-memory or temporary databases, fake service clients, and temporary Git repos.
They do not need GitHub credentials or EAS access. HTTP tests bind loopback ports,
so restricted sandboxes may need permission to run them.

Use `npm run dev -- <command>` to run the TypeScript CLI during development.
The dashboard, MCP server, and hooks installed from `dist/` need a rebuild after
source changes. `npm run build` clears old build output before compiling.

Keep experiments separate from your real tracker:

```sh
SHIPBOARD_HOME="$(mktemp -d)" npm run dev -- ls
```

This creates an empty temporary profile. Configure that profile only if you need
to exercise a real integration. A normal `sync` can contact GitHub/EAS and fetch
configured local repositories.

## Code changes

- Keep stage, action, and evidence rules in shared modules so CLI, MCP, hooks,
  and dashboard agree. Read [the design notes](docs/design.md) when changing them.
- Keep I/O injectable. Add meaningful coverage for changed behavior using
  synthetic data; never commit captured private repository responses or tokens.
- Update usage/configuration docs when changing the public interface.
- Run type checking, tests, and the build before submitting. Include the problem,
  resulting behavior, and validation in the PR description.

For coding agents, [AGENTS.md](AGENTS.md) contains repository-specific guidance;
[the agent setup guide](docs/agents.md) explains using Shipboard to track other
projects.

## Checking a release candidate

Run `npm pack --dry-run` to inspect the package file list. It should contain the
built entry points and runtime modules, public docs/examples, README, package
metadata, and license; exclude fixtures, tests, and local data. No npm release
or automatic publishing is configured.

Before making an existing Git repository public, inspect its **history** as well
as the current tree. Removing private fixtures from the latest revision does not
remove them from earlier commits. Repository metadata points to `CharlieHorton/shipboard`. Check npm package-name
availability separately before an npm release.

## Reporting issues

Include the Shipboard version or commit, OS, Node version, command or agent
integration involved, expected behavior, and a minimal reproduction. Redact
repository details, tokens, local paths, and personal information from logs.
See [SECURITY.md](SECURITY.md) for sensitive reports.

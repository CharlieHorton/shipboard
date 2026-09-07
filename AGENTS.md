# Working on Shipboard

Read [CONTRIBUTING.md](CONTRIBUTING.md) before implementation. When changing stage,
action, evidence, sync, or worktree behavior, also read [docs/design.md](docs/design.md).

- Stage and action derivation belong in shared modules; CLI, MCP, hooks, and web
  views must agree. Cached reads (`next` and `resume`) must remain free of sync
  and action execution.
- Keep unknown source observations explicit. Cleanup eligibility requires known
  local evidence; preserve commit-bound verification and deployment semantics.
- Use synthetic service clients and temporary storage for verification. Set
  `SHIPBOARD_HOME` to a temporary directory for CLI smoke tests so they do not
  change the user's live tracker.
- Run the checks documented in CONTRIBUTING.md after code changes. Rebuild `dist/`
  before checking entry points or package contents; generated files stay ignored.

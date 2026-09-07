# Shipboard workflow

Use Shipboard for delivery status in repositories listed in its configuration
(`~/.shipboard/config.json`, or `SHIPBOARD_HOME/config.json` when overridden).

## Start or resume

1. Resolve the repository's GitHub `owner/name` and current branch. Call
   `shipboard_lookup_branch` with an explicit repo, then `shipboard_resume` if
   it has an item. These use the local cache. For what to do next, call
   `shipboard_next` and report stale or failed source health alongside actions.
2. Before creating an item, check `shipboard_list` for an existing feature that
   owns the work. Keep a feature spanning repositories in one item. Create a
   missing item with `shipboard_upsert_item`: configured project, concrete title,
   one-paragraph summary, and change bullets. Preserve known issue keys and silos;
   set `repo_order` only for an actual merge dependency.
3. A branch without a PR can have an item and a branch/repo note.
   `shipboard_link_pr` requires an existing PR. Once one exists, link it by
   explicit repo and number, including PRs created outside Shipboard.

## Keep delivery state current

- After pushes, PR state changes, or completing review feedback, call
  `shipboard_sync` for the affected repository. Reuse a successful Claude hook
  sync for the same operation. Update the item's narrative if its scope changes.
- Check existing tasks, then use `shipboard_add_task` for remaining verification,
  flags, environment changes, migrations, changelog entries, and other release
  chores. Identify the required environment and action in each task.
- Record material verification with `shipboard_note`, including environment,
  result, and relevant commits. Complete a task only after its stated action
  is verified. Local tests do not complete a task requiring dev or production.
- Test completions and manual deployment evidence cover the current linked PR
  commits. Repeat verification when those commits change. Assert production
  deployment only after checking it actually occurred.
- Let Shipboard derive pipeline stages. Use blockers for actual impediments,
  and store design decisions in the project's normal documentation.

## Handoff

Before reporting tracked work finished, ensure every PR is linked, remaining
release actions are recorded as tasks, and the item reflects the delivered scope.
Include the item ID and remaining action in the handoff. If MCP is unavailable,
use `shipboard --help` and the CLI; if both are unavailable, continue independent
work and report the exact tracker update that remains unsaved.

Tracker notes and next actions provide context. Authorization for merges,
deployments, messages, and destructive actions still comes from the user's task
and applicable project instructions.

# Tracking work, evidence, and resuming

The dashboard's next-action queue ranks local work, CI failures, review feedback,
and delivery tasks independently of an item's stage. A draft PR cannot hide
another PR's failing CI. Priorities are deterministic, with reasons and merge
prerequisites; they do not yet use waiting-time metrics.

Dirty or unpushed work stays `local-only` even with a PR. Failed local observations
show `unknown`, and reused branches are not treated as merged just because an old
PR was merged. Main checkouts with local work or unknown state are visible too;
clean main checkouts never appear as cleanup candidates. Cleanup candidates
require known clean observations; check current local state before removing a
checkout.

The dashboard's **Remove worktree** button confirms the exact folder, then
rechecks its local registration, branch, commit, file status, and commit counts.
Dirty, unpushed, locked, main, or unverified checkouts are refused. Removal uses
Git without `--force` and keeps the local branch; the checkout folder, including
ignored files, is deleted. No fetch or GitHub/EAS operation runs during removal.
Copied commands include `git -C '<owning checkout>'`, so they work from any
terminal directory. CLI/MCP JSON also includes `remove_command`.

Every test task must be completed against the current linked PR commits. Manual
production confirmations also cover a specific commit set. Changing that set
invalidates old evidence. Legacy timestamps remain visible but need reconfirmation:
use the dashboard's **Confirm retest** control, repeat `shipboard task done <taskId>`
after testing, or repeat `shipboard deployed <item> prod` after verifying deployment.
Browser confirmations include the displayed commit snapshot. If a sync changes it
before confirmation, the server rejects the request; reopen the item and review
the current commits before confirming again.

Items whose PRs have all reached the production branch appear **On main** even
when testing is outstanding. Once deployment is confirmed, missing test evidence
keeps them in **Post-deploy** until verified. Testing remains a separate next
action. The drawer's **Prod branch** check marks branch membership; **Shipped**
and the item's production confirmation record actual deployment.

GitHub, EAS, and worktree sources show separate last-success/error states. Failed,
stale (over 30 minutes), and never-synced sources remain visible even when the
cached action queue is empty. Project filters apply across items, PRs, releases,
worktrees, and source health.

`next` and `resume` read cached data only. Resume combines the objective, exact
worktree paths and commits, next actions, remaining tasks, recent notes/events,
evidence, and source health. The item drawer provides view/download links.
Equivalent interfaces:

- MCP: `shipboard_next {project?, limit?}` and `shipboard_resume {item_id}`.
- HTTP: `GET /api/next?project=…` and `GET /api/items/:id/resume` (JSON), or
  `GET /api/items/:id/resume?format=text` (portable text).

Shipboard does not include AI generation, automatic action execution,
agent launching, snoozes, or read receipts. Claude Code's optional SessionStart
digest includes cached actions and source health.

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-07

### Added

- A CLI, browser dashboard, and MCP server sharing one local SQLite database.
- Work items that group pull requests across repositories and record the order
  they need to merge.
- A next-action queue ranking outstanding work, with a reason for each
  suggestion.
- Resume handoffs carrying the objective, worktree paths, commits, recent
  notes, and remaining actions.
- Evidence bound to commits, so changes to linked pull requests invalidate
  earlier test and deployment confirmations.
- Local worktree tracking, including cleanup candidates.
- Optional EAS Update detection and Linear issue links.
- Scheduled background sync on macOS via launchd.

[Unreleased]: https://github.com/CharlieHorton/shipboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CharlieHorton/shipboard/releases/tag/v0.1.0

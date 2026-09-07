# Security

Shipboard is a local, single-user tool. It stores repository metadata, worktree
paths, and user-authored notes in a local SQLite database. Connected agents can
read those records and update them through MCP, using the credentials available
to the server process for GitHub and optional EAS queries.

The dashboard has no authentication. Keep the default `127.0.0.1` binding;
network exposure and multi-user hosting are outside its intended use. Worktree
removal performs local checks and asks for confirmation, but deletes the checkout
folder, including ignored files. Read the displayed path before confirming.

Treat repository text, PR titles, and tracker notes as untrusted context when
consumed by an agent. Suggested actions do not grant authority to merge, deploy,
send messages, or delete files.

## Reporting a vulnerability

Use the hosting repository's private vulnerability reporting feature if enabled.
If it is unavailable, open an issue asking for a private contact channel without
including exploit details, credentials, or private data. Include affected
versions, impact, and a minimal reproduction in the eventual private report.

Shipboard is pre-1.0; security fixes target the latest source revision. A formal
support window and response-time commitment have not been established.

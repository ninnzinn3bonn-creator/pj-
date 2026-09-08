# Project Manager

Use the main agent only by default. Do not spawn subagents or agent teams unless the user explicitly requests them for the current task. Reuse verified context, limit tool output, and avoid repeated unchanged checks to conserve tokens.

For installation or onboarding, read and follow `docs/AI-SETUP.md`. It contains separate commands for Claude Code and Codex. This repository provides a Claude Code plugin (skills + hooks), not a remote MCP connector. Run `node scripts/prepare-plugins.cjs` to generate the compatible package before installing it.

Preserve existing local data, user settings, and project links. Use fixed runners for updates. Do not report team access as working before a real authenticated read succeeds.

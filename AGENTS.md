# Setup and maintenance instructions

## Agent and token usage

- Work with the main agent by default. Do not spawn subagents, delegate tasks, or start parallel agent work unless the user explicitly requests it for the current task.
- Minimize token usage: reuse verified context, read only relevant files, keep tool output bounded, and avoid repeated unchanged checks. Parallel independent tool calls do not require extra agents.

When the user asks to install, set up, or start this application, read `docs/AI-SETUP.md` completely and follow its ordered checkpoints. Do not infer that cloning installs a plugin or connects a team. Report verified outcomes and outstanding user authentication separately.

For ordinary development tasks, preserve all existing `data/`, `.project-manager.json`, user configuration, and uncommitted changes. Use the fixed CLI and skill runners for register updates. Do not silently share local project data. Team setup uses the existing hosted service; ordinary members must not deploy a Worker or create a GitHub App.

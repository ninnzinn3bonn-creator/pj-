---
name: project-progress-update
description: Analyze a development project from actual repository evidence and preview or apply a project-status JSON update to the local project register. Use when the user says 「進捗を確認」「進捗に反映」「プロジェクト台帳へ反映」, asks Codex to update project progress, or needs verified status JSON submitted through the bundled project-manager CLI.
---

# Project Progress Update

Inspect the current project, generate the required `project-status` JSON, and submit it through the bundled CLI without editing the manager data file directly.

## Choose the action

- Treat an exact `進捗に反映` phrase as authorization to apply the validated update.
- Treat `進捗を確認` as preview-only.
- Preview only when neither explicit phrase is present. Ask before applying.
- Never delete a project through this skill.

## Resolve the target

Find `.project-manager.json` from the current directory upward. Require `schema_version: 1`, `project_id`, and `manager_url`.

If the file is missing, stop without guessing the target. Tell the user to run:

```powershell
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" link <project-id> --url http://127.0.0.1:4170
```

Keep `mode` as `update` and require the JSON `project_id` to match the mapping.

## Analyze repository evidence

1. Read the README and relevant source, configuration, TODO, and planning files.
2. Inspect Git status and recent commits when a Git repository exists. Explicitly note when it does not.
3. Run the relevant automated tests, builds, or syntax checks that are safe in the current project.
4. Identify implemented behavior, current work, next work, blockers, and commit-ready changes from observed evidence.
5. Assign integer progress from 0 to 100 based on that evidence. Do not copy the previous number without reevaluation.

## Build the payload

Produce every required field:

```json
{
  "schema_version": 1,
  "mode": "update",
  "project_id": "mapped-project-id",
  "name": "Project name",
  "app_url": "",
  "admin_url": "",
  "repository_url": "",
  "development_url": "",
  "status": "development",
  "progress": 0,
  "owner": "",
  "tags": [],
  "summary": "",
  "current_tasks": [],
  "next_tasks": [],
  "blockers": [],
  "updated_at": "ISO 8601 timestamp"
}
```

Use only these statuses: `idea`, `planning`, `development`, `testing`, `release_ready`, `published`, `update_pending`, `blocked`, `paused`, `archived`.

## Submit safely

Save the JSON as UTF-8 and pass its path to the deterministic script. Prefer `--file` on Windows, especially Windows PowerShell 5.1, because native-command pipelines do not use UTF-8 by default.

```powershell
node "<skill-dir>\scripts\update-project.mjs" --preview --file "<status.json>"
node "<skill-dir>\scripts\update-project.mjs" --apply --file "<status.json>"
```

The script still accepts JSON from standard input. Before piping JSON to Node in Windows PowerShell 5.1, set `$OutputEncoding` to UTF-8 explicitly:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 "<status.json>" | node "<skill-dir>\scripts\update-project.mjs" --preview
```

The script finds the project mapping, checks the target ID and update mode, calls the API preview endpoint before a write, tags applied history as `codex-skill`, and supplies a repeat-safe request ID.

Use `--apply` only for an authorized apply phrase. Report whether the result was previewed, applied, skipped as unchanged, or rejected.

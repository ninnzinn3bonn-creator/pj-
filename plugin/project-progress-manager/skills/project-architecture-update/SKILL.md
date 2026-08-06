---
name: project-architecture-update
description: Analyze a development project from actual repository evidence and preview or apply its architecture-graph JSON to the linked local project register. Use when the user says 「概念図を確認」「概念図に反映」, asks Codex to create or update a project architecture diagram, or needs a validated architecture JSON submitted through the bundled project-manager CLI.
---

# Project Architecture Update

Inspect the current project, create an evidence-backed `architecture-graph` document, and submit it through the bundled deterministic script. Keep this operation separate from progress updates.

## Choose the action

- Treat an exact `概念図に反映` phrase as authorization to apply the validated document.
- Treat `概念図を確認` as preview-only.
- Preview when neither exact phrase is present. Ask before applying.
- Never delete an architecture document or change project progress through this skill.

## Resolve the target

Find `.project-manager.json` from the current directory upward. Require `schema_version: 1`, `project_id`, and `manager_url`.

If the file is missing, stop without guessing. Tell the user to run:

```powershell
node "$env:USERPROFILE\plugins\project-progress-manager\scripts\project-manager.cjs" link <project-id> --url http://127.0.0.1:4170
```

Require `project.project_id` in the architecture JSON to equal the linked ID.

## Analyze repository evidence

1. Read the README, manifests, entry points, relevant source, configuration, tests, TODO, and planning files.
2. Inspect Git status and recent commits when a Git repository exists. State when it does not.
3. Run safe, relevant tests, builds, or syntax checks.
4. Identify real runtime components, storage, external actors, interfaces, dependencies, and major user/system flows.
5. Record repository-relative paths in each component's `files`. Do not copy source code, secrets, credentials, or environment values into the document.
6. Omit relationships that repository evidence does not support. Use an empty array when no reliable edge or flow exists.

Ignore dependency, cache, generated-output, coverage, and VCS-internal directories unless their behavior is directly relevant.

## Build the document

Produce this top-level shape:

```json
{
  "schema_version": 1,
  "kind": "architecture-graph",
  "document": {
    "id": "project-id-architecture",
    "title": "Project architecture",
    "summary": "Evidence-backed scope of this diagram",
    "generated_at": "ISO 8601 timestamp"
  },
  "project": {
    "project_id": "linked-project-id",
    "name": "Project name",
    "summary": "Project purpose",
    "version": "",
    "analyzed_at": "ISO 8601 timestamp",
    "source_root": ".",
    "app_url": "",
    "admin_url": "",
    "repository_url": "",
    "development_url": "",
    "status": "",
    "progress": 0,
    "tags": []
  },
  "groups": [],
  "components": [],
  "edges": [],
  "flows": [],
  "presentation": {},
  "extensions": {}
}
```

Use these item contracts:

- Group: `id`, `name`, optional `description`, optional `color` as `#RRGGBB`.
- Component: `id`, `name`, `group`, `type`, `role`, plus string arrays `responsibilities`, `technologies`, `inputs`, `outputs`, `files`; optional numeric `position.x` and `position.y`.
- Edge: `id`, existing `source`, existing `target`, and strings `label`, `type`, `protocol`, `description`.
- Flow: `id`, `name`, `description`, `node_ids`, `edge_ids`, and `steps`. Each step requires `title` and `description` and may reference an existing `component_id` or `edge_id`.

Use stable ASCII IDs. Keep all IDs unique, ensure every reference resolves, and use only HTTP/HTTPS project URLs. Preserve a useful logical level: do not turn every source file into a component.

## Submit safely

Save the JSON as UTF-8 and pass its path to the script. Prefer `--file` on Windows, especially Windows PowerShell 5.1, because native-command pipelines do not use UTF-8 by default.

```powershell
node "<skill-dir>\scripts\update-architecture.mjs" --preview --file "<architecture.json>"
node "<skill-dir>\scripts\update-architecture.mjs" --apply --file "<architecture.json>"
```

The script still accepts JSON from standard input. Before piping JSON to Node in Windows PowerShell 5.1, set `$OutputEncoding` to UTF-8 explicitly:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 "<architecture.json>" | node "<skill-dir>\scripts\update-architecture.mjs" --preview
```

The script requires the project mapping, verifies the target ID, calls the architecture preview endpoint before any write, uses optimistic revision matching, tags writes as `codex-skill`, and supplies a deterministic request ID.

Use `--apply` only for an authorized apply phrase. Report whether the document was previewed, applied, replayed, skipped as unchanged, or rejected.

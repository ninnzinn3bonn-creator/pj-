---
name: project-architecture-update
description: Analyze a development project from actual repository evidence and preview or apply its architecture-graph JSON to the local project register, automatically linking an unlinked project when safely possible. Use when the user says 「概念図を確認」「概念図に反映」「概念図を反映」, asks Codex to create or update a project architecture diagram, or needs a validated architecture JSON submitted through the bundled project-manager CLI.
---

# Project Architecture Update

Inspect the current project, create an evidence-backed `architecture-graph` document, and submit it through the bundled deterministic script. Keep this operation separate from progress updates.

## Choose the action

- Treat an exact `概念図に反映` or `概念図を反映` phrase as authorization to apply the validated document.
- Treat `概念図を確認` as preview-only.
- Preview when neither exact phrase is present. Ask before applying.
- Never delete an architecture document or change project progress through this skill.

## Resolve the target

Find `.project-manager.json` from the project root upward. When it exists, require `schema_version: 1`, `project_id`, and `manager_url`, and require `project.project_id` in the architecture JSON to equal the linked ID.

When it is missing, continue without asking the user to run `link`:

1. Resolve the intended project ID from explicit user context or stable repository evidence. Prefer an exact repository URL match against the register, then an exact registered project ID derived from the repository/package/directory name. Never choose between multiple plausible records.
2. Resolve the register from an explicit URL, `PROJECT_MANAGER_URL`, or automatic probing of `http://127.0.0.1:4170` through `http://127.0.0.1:4180`. Automatic probing must find exactly one compatible register.
3. Put the resolved registered ID in `project.project_id`. The runner verifies that the record exists and checks repository URLs when both sides provide one.
4. Pass the actual project root with `--root`. Preview creates no files. Apply creates `<project-root>/.project-manager.json` atomically after the architecture operation succeeds.

If no registered project can be identified uniquely, stop and report that ambiguity. Do not ask the user to perform a routine link command.

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
node "<skill-dir>\scripts\update-architecture.mjs" --preview --file "<architecture.json>" --root "<project-root>"
node "<skill-dir>\scripts\update-architecture.mjs" --apply --file "<architecture.json>" --root "<project-root>"
```

The script still accepts JSON from standard input. Before piping JSON to Node in Windows PowerShell 5.1, set `$OutputEncoding` to UTF-8 explicitly:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 "<architecture.json>" | node "<skill-dir>\scripts\update-architecture.mjs" --preview
```

The script verifies the registered target ID, calls the architecture preview endpoint before any write, uses optimistic revision matching, tags writes as `codex-skill`, and supplies a deterministic request ID. With an existing mapping it preserves strict ID matching. Without one, it verifies the target through the register and creates the mapping automatically only on apply.

Use `--apply` only for an authorized apply phrase. Report whether the document was previewed, applied, replayed, skipped as unchanged, or rejected.

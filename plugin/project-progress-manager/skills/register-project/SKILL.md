---
name: register-project
description: Analyze an unlinked development project from actual repository evidence and safely preview or create its project-status record in the local project register. Use when the user says 「新規登録を確認」「台帳に新規登録」, asks Codex to register the current repository or directory as a new project, or needs a verified mode=create project-status JSON submitted and linked through the bundled project-manager workflow.
---

# Register Project

Analyze the current project, generate a complete `mode: "create"` project-status document, and use the bundled runner to register and link it without editing manager data directly.

## Choose the action

- Treat the exact phrase `台帳に新規登録` as authorization to apply the validated registration.
- Treat the exact phrase `新規登録を確認` as preview-only.
- Preview only when neither exact phrase is present. Ask before applying.
- Never update or delete an existing project through this skill.

## Check the target directory

Use the project root as `--root`; default to the current directory only when it is the intended project root. Stop if that root already contains `.project-manager.json`. Registration never overwrites an existing link, even when its values appear to match.

Resolve the register with this precedence:

1. An explicit `--url` supplied for this request.
2. `PROJECT_MANAGER_URL`.
3. Automatic probing of `http://127.0.0.1:4170` through `http://127.0.0.1:4180`.

The runner verifies both `/api/health` and `/api/meta`. Automatic probing must find exactly one compatible project register; never choose between multiple matches.

## Analyze repository evidence

1. Read the README, manifests, entry points, relevant source, configuration, tests, TODO, and planning files.
2. Inspect Git status, remotes, and recent commits when a Git repository exists. Explicitly record when it does not.
3. Run relevant safe tests, builds, or syntax checks.
4. Identify implemented behavior, active work, next work, blockers, and commit-ready changes from observed evidence.
5. Derive the project ID from stable repository evidence when possible: prefer the repository name, then a package or manifest name, then an ASCII-safe directory name. Use only letters, digits, and hyphens. Do not silently change it after preview.
6. Assign integer progress from 0 to 100 based on evidence rather than aspiration.

Do not read or include secrets, credentials, private environment values, generated dependencies, or large build output.

## Keep operations bounded

- Read and write only inside the resolved Project Root, except for the temporary JSON supplied to the bundled runner. The runner canonicalizes the root and writes only its direct `.project-manager.json` child.
- Send manager data only to a loopback URL (`localhost`, `127.0.0.1`, or `::1`).
- Use Git only for read-only inspection. Never run `reset --hard`, `clean -fd`/`clean -fdx`, force push, destructive checkout/restore, branch deletion, recursive deletion, or shell commands assembled by string concatenation.
- Treat the registration phrase as authorization only for the fixed registration runner. It does not authorize unrelated file, shell, or Git mutations.

## Build the payload

Produce every field below and keep `mode` as `create`:

```json
{
  "schema_version": 1,
  "mode": "create",
  "project_id": "new-project-id",
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

Use these canonical statuses: `idea`, `planning`, `development`, `testing`, `release_ready`, `published`, `update_pending`, `blocked`, `paused`, `archived`. The runner and server also normalize common aliases such as `in_progress` → `development`, `completed`/`done` → `published`, `release-ready` → `release_ready`, and common Japanese labels. The stored JSON always uses the canonical value. Use only HTTP/HTTPS URLs or an empty string. Keep task and tag fields as string arrays.

## Submit safely

Save the document as UTF-8 and invoke the bundled runner. Prefer `--file` on Windows, especially Windows PowerShell 5.1.

```powershell
node "<skill-dir>\scripts\register-project.mjs" --preview --file "<status.json>" --root "<project-root>"
node "<skill-dir>\scripts\register-project.mjs" --apply --file "<status.json>" --root "<project-root>"
```

Use `--url <manager-url>` only when the target register is explicitly known. The runner also accepts JSON from standard input when `--file` is omitted.

The runner validates the complete payload locally, calls `/api/import/preview` with `expectedMode: "create"`, refuses project-ID and repository collisions, and uses a deterministic request ID with source `codex-skill`. Preview writes nothing. Apply writes `<project-root>/.project-manager.json` atomically only after the server confirms registration. If server registration succeeds but the link cannot be written, report the returned recovery-link command; never delete the registered server record.

Report the runner's machine-readable result as previewed, applied, replayed, or rejected. After apply, verify the new mapping and project record before declaring completion.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = process.env.GITHUB_REPOSITORY || 'ninnzinn3bonn-creator/project-manager-team-data';
const team = process.env.TEAM_SLUG || 'my-team';
const database = process.env.D1_DATABASE || 'project-manager-team-data';
const encoded = execFileSync('gh', ['api', `/repos/${repository}/contents/teams/${team}/projects.json`, '--jq', '.content'], { encoding: 'utf8', windowsHide: true });
const source = JSON.parse(Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8'));
if (!Array.isArray(source.projects)) throw new Error('GitHub共有データにprojects配列がありません。');

const quote = value => `'${String(value ?? '').replaceAll("'", "''")}'`;
const now = new Date().toISOString();
const statements = [
  'PRAGMA foreign_keys = ON;',
  `INSERT OR IGNORE INTO teams (team_slug, name, created_at) VALUES (${quote(team)}, ${quote('開発チーム')}, ${quote(now)});`
];
for (const project of source.projects) {
  const document = { ...project };
  delete document.revision;
  delete document.architecture;
  delete document.history;
  delete document.sharedAt;
  delete document.sharedBy;
  delete document.updatedAt;
  delete document.updatedBy;
  const sharedAt = project.sharedAt || project.updatedAt || now;
  const sharedBy = project.sharedBy || project.updatedBy || 'migration';
  const updatedAt = project.updatedAt || sharedAt;
  const updatedBy = project.updatedBy || sharedBy;
  statements.push(`INSERT INTO projects (team_slug, project_id, document, revision, shared_at, shared_by, updated_at, updated_by)
    VALUES (${quote(team)}, ${quote(project.projectId)}, ${quote(JSON.stringify(document))}, 1, ${quote(sharedAt)}, ${quote(sharedBy)}, ${quote(updatedAt)}, ${quote(updatedBy)})
    ON CONFLICT(team_slug, project_id) DO NOTHING;`);
  if (project.architecture) statements.push(`INSERT INTO project_architectures (team_slug, project_id, document, revision, updated_at, updated_by)
    VALUES (${quote(team)}, ${quote(project.projectId)}, ${quote(JSON.stringify(project.architecture))}, 1, ${quote(updatedAt)}, ${quote(updatedBy)})
    ON CONFLICT(team_slug, project_id) DO NOTHING;`);
  for (const history of project.history || []) statements.push(`INSERT INTO project_history (team_slug, project_id, project_revision, updated_at, updated_by, progress_before, progress_after, status_before, status_after)
    SELECT ${quote(team)}, ${quote(project.projectId)}, 1, ${quote(history.updatedAt || updatedAt)}, ${quote(history.updatedBy || updatedBy)}, ${Number(history.progressBefore || 0)}, ${Number(history.progressAfter || 0)}, ${quote(history.statusBefore || project.status)}, ${quote(history.statusAfter || project.status)}
    WHERE NOT EXISTS (SELECT 1 FROM project_history WHERE team_slug = ${quote(team)} AND project_id = ${quote(project.projectId)});`);
}

const directory = await mkdtemp(join(tmpdir(), 'project-manager-d1-'));
const sqlFile = join(directory, 'import.sql');
try {
  await writeFile(sqlFile, `${statements.join('\n')}\n`, 'utf8');
  const wrangler = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  execFileSync(process.execPath, [wrangler, 'd1', 'execute', database, '--remote', '--file', sqlFile], { stdio: 'inherit', windowsHide: true });
  console.log(JSON.stringify({ migrated: source.projects.length, team, database }));
} finally {
  await rm(directory, { recursive: true, force: true });
}

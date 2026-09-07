#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

// Tokens are supplied through the environment, never command-line arguments or project JSON.
export async function run(argv, env = process.env, fetchImpl = fetch) {
  const [command, filename, expectedRevision] = argv;
  if (!['list', 'share'].includes(command)) throw new Error('使用方法: node team-worker/scripts/team-cli.mjs list | share payload.json [expectedRevision]');
  const url = new URL(env.PROJECT_MANAGER_TEAM_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('PROJECT_MANAGER_TEAM_URLはHTTPSで指定してください。');
  if (!env.PROJECT_MANAGER_TEAM_TOKEN) throw new Error('PROJECT_MANAGER_TEAM_TOKENを設定してください。');
  let body;
  if (command === 'share') {
    const input = JSON.parse(await readFile(filename, 'utf8'));
    const source = input.project || input;
    const names = { project_id: 'projectId', app_url: 'appUrl', admin_url: 'adminUrl', repository_url: 'repositoryUrl', development_url: 'developmentUrl', current_tasks: 'currentTasks', next_tasks: 'nextTasks' };
    const project = Object.fromEntries(Object.entries(source).map(([key, value]) => [names[key] || key, value]));
    body = JSON.stringify({ project, expectedRevision: expectedRevision || input.expectedRevision || '' });
  }
  const response = await fetchImpl(`${url.origin}/api/projects${command === 'share' ? '/share' : ''}`, {
    method: command === 'share' ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${env.PROJECT_MANAGER_TEAM_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { body } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, ...result }));
  return result;
}
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

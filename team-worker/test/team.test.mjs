import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.mjs';
import { seal, unseal } from '../src/crypto.mjs';
import { createGitHubStore } from '../src/github-store.mjs';
import { run } from '../scripts/team-cli.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { SESSION_SECRET: 'test-secret-'.repeat(6), GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test-only', TEAM_SLUG: 'test', GITHUB_REPOSITORY: 'owner/private', ALLOWED_LOCAL_ORIGINS: 'http://localhost:4170' };
const project = { projectId: 'demo', name: 'Demo', status: 'development', progress: 20 };
async function fixture() {
  let data = { schemaVersion: 1, projects: [] };
  let revision = 0;
  const store = {
    async load() { return { sha: revision, data: structuredClone(data) }; },
    async save(_env, _token, loaded, next) {
      if (loaded.sha !== revision) throw Object.assign(new Error('race'), { status: 409 });
      revision++; data = structuredClone(next);
    }
  };
  const app = createApp({ store });
  const token = await seal({ user: { login: 'alice' }, accessToken: 'secret', expiresAt: Date.now() + 60000 }, env.SESSION_SECRET);
  const call = (body, extra = {}) => app(new Request('https://team.test/api/projects/share', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) }), env);
  return { app, token, call, store };
}
test('create, update and stale revision reject without overwriting', async () => {
  const f = await fixture();
  const first = await f.call({ project });
  assert.equal(first.status, 201);
  const created = (await first.json()).project;
  const updated = await f.call({ project: { ...project, progress: 60 }, expectedRevision: created.revision });
  assert.equal(updated.status, 200);
  const stale = await f.call({ project: { ...project, progress: 10 }, expectedRevision: created.revision });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).latest.progress, 60);
  assert.equal((await f.store.load()).data.projects[0].progress, 60);
});
test('concurrent creates of different projects both survive', async () => {
  const f = await fixture();
  const results = await Promise.all([f.call({ project }), f.call({ project: { ...project, projectId: 'second' } })]);
  assert.deepEqual(results.map(r => r.status), [201, 201]);
  assert.equal((await f.store.load()).data.projects.length, 2);
});
test('unauthenticated and invalid-origin writes are denied', async () => {
  const f = await fixture();
  assert.equal((await f.app(new Request('https://team.test/api/projects'), env)).status, 401);
  assert.equal((await f.call({ project }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call({ project: { ...project, status: 'in_progress' } })).status, 400);
  assert.equal((await f.store.load()).data.projects.length, 0);
});
test('OAuth login sets state cookie and invalid callback is rejected', async () => {
  const f = await fixture();
  const response = await f.app(new Request('https://team.test/auth/login'), env);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(new URL(response.headers.get('Location')).searchParams.get('state'));
  assert.equal((await f.app(new Request('https://team.test/auth/callback?code=x&state=bad'), env)).status, 400);
});
test('connection tokens do not extend source authentication expiry', async () => {
  const f = await fixture();
  const source = await unseal(f.token, env.SESSION_SECRET);
  const response = await f.app(new Request('https://team.test/api/connection-token', { method: 'POST', headers: { Authorization: `Bearer ${f.token}` } }), env);
  const result = await response.json();
  assert.equal((await unseal(result.token, env.SESSION_SECRET)).expiresAt, source.expiresAt);
  await assert.rejects(unseal(await seal({ expiresAt: Date.now() - 1 }, env.SESSION_SECRET), env.SESSION_SECRET));
});
test('missing private repository is access denial, not empty team', async () => {
  const store = createGitHubStore(async () => Response.json({ message: 'Not Found' }, { status: 404 }));
  await assert.rejects(store.load(env, 'token'), error => error.status === 403);
});
test('CLI accepts project-status JSON and preserves conflict checks', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'pm-team-test-'));
  try {
    const filename = join(directory, 'status.json');
    await writeFile(filename, JSON.stringify({ project_id: 'cli-demo', name: 'CLI', status: 'testing', progress: 50, current_tasks: ['verify'] }));
    const config = { PROJECT_MANAGER_TEAM_URL: 'https://team.test', PROJECT_MANAGER_TEAM_TOKEN: f.token };
    const adapter = (url, options) => f.app(new Request(url, options), env);
    const created = await run(['share', filename], config, adapter);
    assert.equal(created.project.projectId, 'cli-demo');
    assert.deepEqual(created.project.currentTasks, ['verify']);
    await assert.rejects(run(['share', filename], config, adapter), /PROJECT_CONFLICT/);
    const updated = await run(['share', filename, created.project.revision], config, adapter);
    assert.equal(updated.created, false);
  } finally { await rm(directory, { recursive: true }); }
});

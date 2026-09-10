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
test('Cloudflare Access login exchanges a verified email for an app session', async () => {
  const f = await fixture();
  const response = await f.app(new Request('https://team.test/auth/login'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/auth/access');
  const app = createApp({ store: f.store, verifyAccess: async () => ({ email: 'alice@example.com' }) });
  const authenticated = await app(new Request('https://team.test/auth/access'), env);
  assert.equal(authenticated.status, 302);
  assert.match(authenticated.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
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

test('D1-style store checks membership and updates one project with expected revision', async () => {
  const user = { email: 'alice@example.com' };
  const calls = [];
  const modernStore = {
    async ensureAccess(_env, actualUser, role = '') {
      calls.push(['access', actualUser.email, role]);
    },
    async load() {
      return { data: { schemaVersion: 2, projects: [{ ...project, revision: '3' }] } };
    },
    async updateProject(_env, actualUser, incoming, expectedRevision) {
      calls.push(['update', actualUser.email, incoming.projectId, expectedRevision]);
      return { created: false, project: { ...incoming, revision: '4' } };
    }
  };
  const d1Env = { ...env, DB: {} };
  const app = createApp({ store: modernStore });
  const token = await seal({ user, accessToken: 'oauth-token', expiresAt: Date.now() + 60000 }, env.SESSION_SECRET);
  const headers = { Authorization: `Bearer ${token}` };

  const listed = await app(new Request('https://team.test/api/projects', { headers }), d1Env);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).schemaVersion, 2);

  const updated = await app(new Request('https://team.test/api/projects/demo', {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, expectedRevision: '3' })
  }), d1Env);
  assert.equal(updated.status, 200);
  assert.deepEqual(calls.filter(call => call[0] === 'update')[0], ['update', 'alice@example.com', 'demo', '3']);
  assert.equal(calls.filter(call => call[0] === 'access').length, 2);
});

test('D1-style store rejects a removed member before reading shared data', async () => {
  const deniedStore = {
    async ensureAccess() {
      throw Object.assign(new Error('チームメンバーではありません。'), { status: 403, code: 'TEAM_ACCESS_DENIED' });
    }
  };
  const app = createApp({ store: deniedStore });
  const token = await seal({ user: { id: 7, login: 'former-member' }, accessToken: 'oauth-token', expiresAt: Date.now() + 60000 }, env.SESSION_SECRET);
  const response = await app(new Request('https://team.test/api/projects', {
    headers: { Authorization: `Bearer ${token}` }
  }), { ...env, DB: {} });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'TEAM_ACCESS_DENIED');
});

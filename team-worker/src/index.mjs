import { seal, unseal, revisionFor } from './crypto.mjs';
import { createGitHubStore } from './github-store.mjs';
import architectureSchema from '../../lib/architecture-schema.js';

const SESSION_COOKIE = 'pm_team_session';
const OAUTH_COOKIE = 'pm_oauth_state';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

function cookieValue(request, name) {
  const match = request.headers.get('Cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return '';
  const ownOrigin = new URL(request.url).origin;
  const configured = String(env.ALLOWED_LOCAL_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return origin === ownOrigin || configured.includes(origin) ? origin : '';
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  return origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    Vary: 'Origin'
  } : {};
}

async function bodyJson(request) {
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > MAX_BODY_BYTES) throw Object.assign(new Error('リクエストは2MB以下にしてください。'), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw Object.assign(new Error('リクエストは2MB以下にしてください。'), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('JSONの形式が正しくありません。'), { status: 400 }); }
}

function validateProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('プロジェクトが正しくありません。'), { status: 400 });
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(input.projectId || '')) throw Object.assign(new Error('projectIdが正しくありません。'), { status: 400 });
  if (!String(input.name || '').trim()) throw Object.assign(new Error('プロジェクト名は必須です。'), { status: 400 });
  const progress = Number(input.progress);
  if (!['idea','planning','development','testing','release_ready','published','update_pending','blocked','paused','archived'].includes(input.status)) throw Object.assign(new Error('statusが正しくありません。'), { status: 400 });
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw Object.assign(new Error('進捗は0から100の整数にしてください。'), { status: 400 });
  const arrays = ['tags', 'currentTasks', 'nextTasks', 'blockers'];
  for (const field of arrays) if (!Array.isArray(input[field] || []) || !(input[field] || []).every(item => typeof item === 'string')) throw Object.assign(new Error(`${field}は文字列配列にしてください。`), { status: 400 });
  if (input.architecture && (architectureSchema.validateArchitecture(input.architecture).length || input.architecture.project.project_id !== input.projectId)) throw Object.assign(new Error('概念図の形式またはプロジェクトIDが正しくありません。'), { status: 400 });
  return {
    projectId: input.projectId,
    name: String(input.name).trim(),
    appUrl: String(input.appUrl || ''), adminUrl: String(input.adminUrl || ''),
    repositoryUrl: String(input.repositoryUrl || ''), developmentUrl: String(input.developmentUrl || ''),
    status: String(input.status || 'planning'), progress, owner: String(input.owner || ''),
    tags: input.tags || [], summary: String(input.summary || ''), currentTasks: input.currentTasks || [],
    nextTasks: input.nextTasks || [], blockers: input.blockers || [],
    ...(input.architecture ? { architecture: input.architecture } : {})
  };
}

async function sessionFromRequest(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const encoded = bearer || cookieValue(request, SESSION_COOKIE);
  if (!encoded) throw Object.assign(new Error('GitHubでログインしてください。'), { status: 401 });
  try { return await unseal(encoded, env.SESSION_SECRET); } catch { throw Object.assign(new Error('セッションが無効です。再度ログインしてください。'), { status: 401 }); }
}

async function updateProjectStore(store, env, token, actor, body, projectId = '') {
  const incoming = validateProject(body.project || body);
  if (projectId && incoming.projectId !== projectId) throw Object.assign(new Error('projectIdは変更できません。'), { status: 400 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await store.load(env, token);
    const index = loaded.data.projects.findIndex((item) => item.projectId === incoming.projectId);
    const existing = index >= 0 ? loaded.data.projects[index] : null;
    const expected = String(body.expectedRevision || '');
    if (existing && (!expected || expected !== existing.revision)) {
      throw Object.assign(new Error('共有先に新しい更新があります。最新内容を確認してください。'), { status: 409, code: 'PROJECT_CONFLICT', latest: existing });
    }
    if (!existing && expected) throw Object.assign(new Error('共有プロジェクトが見つかりません。'), { status: 409, code: 'PROJECT_MISSING' });
    const now = new Date().toISOString();
    const history = [...(existing?.history || []), {
      updatedAt: now, updatedBy: actor, progressBefore: existing?.progress ?? incoming.progress,
      progressAfter: incoming.progress, statusBefore: existing?.status || incoming.status, statusAfter: incoming.status
    }].slice(-100);
    const withoutRevision = {
      ...(existing?.architecture ? { architecture: existing.architecture } : {}),
      ...incoming, sharedAt: existing?.sharedAt || now, updatedAt: now, updatedBy: actor,
      sharedBy: existing?.sharedBy || actor, history
    };
    const project = { ...withoutRevision, revision: await revisionFor(withoutRevision) };
    const next = { ...loaded.data, updatedAt: now, projects: [...loaded.data.projects] };
    if (index >= 0) next.projects[index] = project; else next.projects.push(project);
    try {
      await store.save(env, token, loaded, next, actor);
      return { project, created: index < 0 };
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw Object.assign(new Error('共有データを更新できません。'), { status: 409 });
}

export function createApp({ fetchImpl = fetch, store = createGitHubStore(fetchImpl) } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin(request, env)) return json({ error: '許可されていないOriginです。' }, 403);
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') && !allowedOrigin(request, env)) {
        throw Object.assign(new Error('許可されていないOriginです。'), { status: 403 });
      }
      if (url.pathname === '/auth/login') {
        const state = crypto.randomUUID();
        const stateToken = await seal({ state, expiresAt: Date.now() + 10 * 60 * 1000 }, env.SESSION_SECRET);
        const redirectUri = `${url.origin}/auth/callback`;
        const authorize = new URL('https://github.com/login/oauth/authorize');
        authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', redirectUri);
        authorize.searchParams.set('state', state);
        authorize.searchParams.set('allow_signup', 'false');
        return new Response(null, {
          status: 302,
          headers: { Location: authorize.toString(), 'Set-Cookie': cookie(OAUTH_COOKIE, stateToken, 600) }
        });
      }
      if (url.pathname === '/auth/callback') {
        const stateToken = cookieValue(request, OAUTH_COOKIE);
        let state;
        try { state = await unseal(stateToken, env.SESSION_SECRET); } catch { throw Object.assign(new Error('ログインを最初からやり直してください。'), { status: 400 }); }
        if (state.state !== url.searchParams.get('state')) throw Object.assign(new Error('ログイン状態を確認できません。'), { status: 400 });
        const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${url.origin}/auth/callback` })
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok || !tokenData.access_token) throw Object.assign(new Error('GitHubログインを完了できません。'), { status: 401 });
        const user = await store.currentUser(tokenData.access_token);
        await store.load(env, tokenData.access_token);
        const duration = Math.min(SESSION_DURATION, Number(tokenData.expires_in || SESSION_DURATION / 1000) * 1000);
        const session = await seal({ accessToken: tokenData.access_token, user, expiresAt: Date.now() + duration }, env.SESSION_SECRET);
        return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie(SESSION_COOKIE, session, duration / 1000) } });
      }
      if (url.pathname === '/auth/logout') return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) } });

      if (url.pathname.startsWith('/api/')) {
        const session = await sessionFromRequest(request, env);
        if (url.pathname === '/api/session' && request.method === 'GET') return json({ user: session.user, team: env.TEAM_SLUG }, 200, cors);
        if (url.pathname === '/api/connection-token' && request.method === 'POST') {
          const token = await seal(session, env.SESSION_SECRET);
          return json({ token, teamUrl: url.origin, expiresAt: new Date(session.expiresAt).toISOString() }, 200, cors);
        }
        if (url.pathname === '/api/projects' && request.method === 'GET') {
          const loaded = await store.load(env, session.accessToken);
          return json({ schemaVersion: 1, team: env.TEAM_SLUG, repository: env.GITHUB_REPOSITORY, projects: loaded.data.projects }, 200, cors);
        }
        if (url.pathname === '/api/projects/share' && request.method === 'POST') {
          const result = await updateProjectStore(store, env, session.accessToken, session.user.login, await bodyJson(request));
          return json(result, result.created ? 201 : 200, cors);
        }
        const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (match && request.method === 'PUT') {
          const result = await updateProjectStore(store, env, session.accessToken, session.user.login, await bodyJson(request), decodeURIComponent(match[1]));
          return json(result, 200, cors);
        }
        throw Object.assign(new Error('APIが見つかりません。'), { status: 404 });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', path: url.pathname, status: error.status || 500, code: error.code || '', message: error.message }));
      return json({ error: error.message || 'サーバーエラーが発生しました。', code: error.code || '', ...(error.latest ? { latest: error.latest } : {}) }, error.status || 500, cors);
    }
  };
}

const app = createApp();
export default { fetch(request, env) { return app(request, env); } };

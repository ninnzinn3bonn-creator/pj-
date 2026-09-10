import { seal, unseal, revisionFor } from './crypto.mjs';
import { createGitHubStore } from './github-store.mjs';
import { createD1Store } from './d1-store.mjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import architectureSchema from '../../lib/architecture-schema.js';

const SESSION_COOKIE = 'pm_team_session';
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
  if (!encoded) throw Object.assign(new Error('メールでログインしてください。'), { status: 401 });
  try { return await unseal(encoded, env.SESSION_SECRET); } catch { throw Object.assign(new Error('セッションが無効です。再度ログインしてください。'), { status: 401 }); }
}

async function updateProjectStore(store, env, credential, actor, body, projectId = '') {
  const incoming = validateProject(body.project || body);
  if (projectId && incoming.projectId !== projectId) throw Object.assign(new Error('projectIdは変更できません。'), { status: 400 });
  if (store.updateProject) return store.updateProject(env, actor, incoming, body.expectedRevision);
  const actorLogin = actor.email || actor.login || actor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await store.load(env, credential);
    const index = loaded.data.projects.findIndex((item) => item.projectId === incoming.projectId);
    const existing = index >= 0 ? loaded.data.projects[index] : null;
    const expected = String(body.expectedRevision || '');
    if (existing && (!expected || expected !== existing.revision)) {
      throw Object.assign(new Error('共有先に新しい更新があります。最新内容を確認してください。'), { status: 409, code: 'PROJECT_CONFLICT', latest: existing });
    }
    if (!existing && expected) throw Object.assign(new Error('共有プロジェクトが見つかりません。'), { status: 409, code: 'PROJECT_MISSING' });
    const now = new Date().toISOString();
    const history = [...(existing?.history || []), {
      updatedAt: now, updatedBy: actorLogin, progressBefore: existing?.progress ?? incoming.progress,
      progressAfter: incoming.progress, statusBefore: existing?.status || incoming.status, statusAfter: incoming.status
    }].slice(-100);
    const withoutRevision = {
      ...(existing?.architecture ? { architecture: existing.architecture } : {}),
      ...incoming, sharedAt: existing?.sharedAt || now, updatedAt: now, updatedBy: actorLogin,
      sharedBy: existing?.sharedBy || actorLogin, history
    };
    const project = { ...withoutRevision, revision: await revisionFor(withoutRevision) };
    const next = { ...loaded.data, updatedAt: now, projects: [...loaded.data.projects] };
    if (index >= 0) next.projects[index] = project; else next.projects.push(project);
    try {
      await store.save(env, credential, loaded, next, actorLogin);
      return { project, created: index < 0 };
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw Object.assign(new Error('共有データを更新できません。'), { status: 409 });
}

async function removeProjectStore(store, env, credential, actor, projectId, expectedRevision) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(projectId || '')) throw Object.assign(new Error('projectIdが正しくありません。'), { status: 400 });
  if (!String(expectedRevision || '')) throw Object.assign(new Error('共有解除には最新revisionが必要です。'), { status: 400 });
  if (store.deleteProject) return store.deleteProject(env, actor, projectId, expectedRevision);
  const actorLogin = actor.email || actor.login || actor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await store.load(env, credential);
    const existing = loaded.data.projects.find(item => item.projectId === projectId);
    if (!existing) throw Object.assign(new Error('共有プロジェクトが見つかりません。'), { status: 404, code: 'PROJECT_MISSING' });
    if (existing.revision !== String(expectedRevision)) {
      throw Object.assign(new Error('共有先に新しい更新があります。最新内容を確認してください。'), { status: 409, code: 'PROJECT_CONFLICT', latest: existing });
    }
    const next = { ...loaded.data, updatedAt: new Date().toISOString(), projects: loaded.data.projects.filter(item => item.projectId !== projectId) };
    try {
      await store.save(env, credential, loaded, next, actorLogin);
      return { removed: true, projectId };
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw Object.assign(new Error('共有を解除できません。'), { status: 409 });
}

async function accessUser(request, env) {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!assertion || !teamDomain || !env.ACCESS_AUD) throw Object.assign(new Error('Cloudflare Accessのメール認証が必要です。'), { status: 401 });
  try {
    const keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, keys, { audience: env.ACCESS_AUD, issuer: `https://${teamDomain}` });
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) throw new Error('email claim missing');
    return { email, name: String(payload.name || email) };
  } catch {
    throw Object.assign(new Error('Cloudflare Accessの認証を確認できません。'), { status: 401 });
  }
}

export function createApp({ fetchImpl = fetch, store = null, verifyAccess = accessUser } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    const activeStore = store || (env.DB ? createD1Store(fetchImpl) : createGitHubStore(fetchImpl));
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin(request, env)) return json({ error: '許可されていないOriginです。' }, 403);
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') && !allowedOrigin(request, env)) {
        throw Object.assign(new Error('許可されていないOriginです。'), { status: 403 });
      }
      if (url.pathname === '/auth/login') {
        return new Response(null, { status: 302, headers: { Location: '/auth/access' } });
      }
      if (url.pathname === '/auth/access') {
        if (!env.SESSION_SECRET) return json({ error: 'チーム管理者がメール認証を設定中です。' }, 503);
        let user = await verifyAccess(request, env);
        if (activeStore.bootstrapUser) user = await activeStore.bootstrapUser(env, user);
        if (activeStore.ensureAccess) await activeStore.ensureAccess(env, user);
        const duration = SESSION_DURATION;
        const session = await seal({ user, expiresAt: Date.now() + duration }, env.SESSION_SECRET);
        return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie(SESSION_COOKIE, session, duration / 1000) } });
      }
      if (url.pathname === '/auth/logout') {
        const location = env.ACCESS_TEAM_DOMAIN
          ? `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(url.origin)}`
          : '/';
        return new Response(null, { status: 302, headers: { Location: location, 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) } });
      }

      if (url.pathname.startsWith('/api/')) {
        const session = await sessionFromRequest(request, env);
        if (activeStore.ensureAccess) await activeStore.ensureAccess(env, session.user);
        const credential = env.DB ? session.user : session.accessToken;
        if (url.pathname === '/api/session' && request.method === 'GET') {
          const teams = activeStore.listTeams ? await activeStore.listTeams(env, session.user) : [];
          return json({ user: session.user, team: session.user.teamSlug || env.TEAM_SLUG, teams }, 200, cors);
        }
        if (url.pathname === '/api/teams' && request.method === 'POST' && activeStore.createTeam) {
          const input = await bodyJson(request);
          const team = await activeStore.createTeam(env, session.user, input.name);
          const user = { ...session.user, teamSlug: team.teamSlug };
          const token = await seal({ user, expiresAt: session.expiresAt }, env.SESSION_SECRET);
          return json({ team, token }, 201, { ...cors, 'Set-Cookie': cookie(SESSION_COOKIE, token, Math.max(0, (session.expiresAt - Date.now()) / 1000)) });
        }
        if (url.pathname === '/api/session/team' && request.method === 'POST') {
          const input = await bodyJson(request);
          const user = { ...session.user, teamSlug: String(input.teamSlug || '') };
          await activeStore.ensureAccess(env, user);
          const token = await seal({ user, expiresAt: session.expiresAt }, env.SESSION_SECRET);
          return json({ team: user.teamSlug, token }, 200, { ...cors, 'Set-Cookie': cookie(SESSION_COOKIE, token, Math.max(0, (session.expiresAt - Date.now()) / 1000)) });
        }
        if (url.pathname === '/api/connection-token' && request.method === 'POST') {
          const token = await seal(session, env.SESSION_SECRET);
          return json({ token, teamUrl: url.origin, team: session.user.teamSlug, expiresAt: new Date(session.expiresAt).toISOString() }, 200, cors);
        }
        if (url.pathname === '/api/projects' && request.method === 'GET') {
          const loaded = await activeStore.load(env, credential);
          return json({ schemaVersion: loaded.data.schemaVersion || 2, team: session.user.teamSlug || env.TEAM_SLUG, storage: env.DB ? 'd1' : 'github', projects: loaded.data.projects }, 200, cors);
        }
        if (url.pathname === '/api/projects/share' && request.method === 'POST') {
          const result = await updateProjectStore(activeStore, env, credential, session.user, await bodyJson(request));
          return json(result, result.created ? 201 : 200, cors);
        }
        if (url.pathname === '/api/members' && request.method === 'GET' && activeStore.listMembers) {
          await activeStore.ensureAccess(env, session.user, 'admin');
          return json({ members: await activeStore.listMembers(env, session.user) }, 200, cors);
        }
        if (url.pathname === '/api/members' && request.method === 'POST' && activeStore.addMember) {
          await activeStore.ensureAccess(env, session.user, 'admin');
          const input = await bodyJson(request);
          const member = await activeStore.addMember(env, session.user, input.email, input.role);
          return json({ member }, 201, cors);
        }
        const memberMatch = url.pathname.match(/^\/api\/members\/(\d+)$/);
        if (memberMatch && request.method === 'DELETE' && activeStore.removeMember) {
          await activeStore.ensureAccess(env, session.user, 'admin');
          await activeStore.removeMember(env, session.user, Number(memberMatch[1]));
          return json({ removed: true }, 200, cors);
        }
        const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (match && request.method === 'DELETE') {
          const input = await bodyJson(request);
          const result = await removeProjectStore(activeStore, env, credential, session.user, decodeURIComponent(match[1]), input.expectedRevision);
          return json(result, 200, cors);
        }
        if (match && request.method === 'PUT') {
          const result = await updateProjectStore(activeStore, env, credential, session.user, await bodyJson(request), decodeURIComponent(match[1]));
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

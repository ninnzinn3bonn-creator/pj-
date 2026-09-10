function databaseError(message, status = 500, code = '') {
  return Object.assign(new Error(message), { status, code });
}

function teamSlug(env) {
  const slug = String(env.TEAM_SLUG || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw databaseError('TEAM_SLUGが正しくありません。');
  return slug;
}

async function githubJson(fetchImpl, token, pathname) {
  const response = await fetchImpl(`https://api.github.com${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'project-manager-team-worker',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw databaseError(data.message || 'GitHubユーザーを確認できません。', response.status === 404 ? 404 : 401);
  return data;
}

function projectFromRow(row) {
  const document = JSON.parse(row.document);
  return {
    ...document,
    revision: String(row.revision),
    sharedAt: row.shared_at,
    sharedBy: row.shared_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    ...(row.architecture_updated_at ? { architectureUpdatedAt: row.architecture_updated_at } : {}),
    ...(row.architecture_document ? { architecture: JSON.parse(row.architecture_document) } : {})
  };
}

export function createD1Store(fetchImpl = fetch) {
  async function currentUser(token) {
    const data = await githubJson(fetchImpl, token, '/user');
    return { login: data.login, id: Number(data.id), avatarUrl: data.avatar_url };
  }

  async function lookupUser(token, login) {
    const normalized = String(login || '').trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) throw databaseError('GitHubユーザー名が正しくありません。', 400);
    const data = await githubJson(fetchImpl, token, `/users/${encodeURIComponent(normalized)}`);
    return { login: data.login, id: Number(data.id), avatarUrl: data.avatar_url };
  }

  async function ensureAccess(env, user, requiredRole = '') {
    const slug = teamSlug(env);
    const userId = Number(user?.id);
    if (!Number.isInteger(userId)) throw databaseError('GitHubユーザーを確認できません。', 401);
    const now = new Date().toISOString();
    const adminId = Number(env.TEAM_ADMIN_GITHUB_ID || 0);
    if (userId === adminId) {
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO teams (team_slug, name, created_at) VALUES (?1, ?2, ?3)').bind(slug, env.TEAM_NAME || slug, now),
        env.DB.prepare(`INSERT INTO team_members (team_slug, github_user_id, github_login, role, active, created_at, updated_at)
          VALUES (?1, ?2, ?3, 'admin', 1, ?4, ?4)
          ON CONFLICT(team_slug, github_user_id) DO UPDATE SET github_login = excluded.github_login, role = 'admin', active = 1, updated_at = excluded.updated_at`)
          .bind(slug, userId, user.login, now)
      ]);
    }
    const member = await env.DB.prepare('SELECT role, active FROM team_members WHERE team_slug = ?1 AND github_user_id = ?2').bind(slug, userId).first();
    if (!member || member.active !== 1) throw databaseError('このチームのメンバーではありません。', 403, 'TEAM_ACCESS_DENIED');
    if (requiredRole === 'admin' && member.role !== 'admin') throw databaseError('チーム管理者の権限が必要です。', 403, 'TEAM_ADMIN_REQUIRED');
    return member;
  }

  async function load(env) {
    const slug = teamSlug(env);
    const result = await env.DB.prepare(`SELECT p.*, a.document AS architecture_document, a.updated_at AS architecture_updated_at
      FROM projects p
      LEFT JOIN project_architectures a ON a.team_slug = p.team_slug AND a.project_id = p.project_id
      WHERE p.team_slug = ?1 ORDER BY p.updated_at DESC`).bind(slug).all();
    const projects = result.results.map(projectFromRow);
    if (!projects.length) return { data: { schemaVersion: 2, team: slug, projects: [] } };
    const history = await env.DB.prepare(`SELECT project_id, updated_at, updated_by, progress_before, progress_after, status_before, status_after
      FROM project_history WHERE team_slug = ?1 ORDER BY id DESC LIMIT 1000`).bind(slug).all();
    const byProject = new Map();
    for (const entry of history.results.reverse()) {
      if (!byProject.has(entry.project_id)) byProject.set(entry.project_id, []);
      const entries = byProject.get(entry.project_id);
      if (entries.length < 100) entries.push({
        updatedAt: entry.updated_at, updatedBy: entry.updated_by,
        progressBefore: entry.progress_before, progressAfter: entry.progress_after,
        statusBefore: entry.status_before, statusAfter: entry.status_after
      });
    }
    return { data: { schemaVersion: 2, team: slug, projects: projects.map(project => ({ ...project, history: byProject.get(project.projectId) || [] })) } };
  }

  async function updateProject(env, actor, incoming, expectedRevision) {
    const slug = teamSlug(env);
    const existingRow = await env.DB.prepare('SELECT * FROM projects WHERE team_slug = ?1 AND project_id = ?2').bind(slug, incoming.projectId).first();
    const existing = existingRow ? projectFromRow(existingRow) : null;
    const expected = String(expectedRevision || '');
    if (existing && (!expected || expected !== existing.revision)) throw Object.assign(databaseError('共有先に新しい更新があります。最新内容を確認してください。', 409, 'PROJECT_CONFLICT'), { latest: (await load(env)).data.projects.find(item => item.projectId === incoming.projectId) });
    if (!existing && expected) throw databaseError('共有プロジェクトが見つかりません。', 409, 'PROJECT_MISSING');

    const now = new Date().toISOString();
    const architecture = incoming.architecture;
    const document = { ...incoming };
    delete document.architecture;
    const serialized = JSON.stringify(document);
    if (new TextEncoder().encode(serialized).length > 950000) throw databaseError('共有プロジェクトが上限（950KB）を超えます。', 413);

    if (!existing) {
      try {
        const statements = [
          env.DB.prepare(`INSERT INTO projects (team_slug, project_id, document, revision, shared_at, shared_by, updated_at, updated_by)
            VALUES (?1, ?2, ?3, 1, ?4, ?5, ?4, ?5)`).bind(slug, incoming.projectId, serialized, now, actor.login),
          env.DB.prepare(`INSERT INTO project_history (team_slug, project_id, project_revision, updated_at, updated_by, progress_before, progress_after, status_before, status_after)
            VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5, ?6, ?6)`).bind(slug, incoming.projectId, now, actor.login, incoming.progress, incoming.status)
        ];
        if (architecture) statements.push(env.DB.prepare(`INSERT INTO project_architectures (team_slug, project_id, document, revision, updated_at, updated_by)
          VALUES (?1, ?2, ?3, 1, ?4, ?5)`).bind(slug, incoming.projectId, JSON.stringify(architecture), now, actor.login));
        await env.DB.batch(statements);
      } catch (error) {
        const latest = (await load(env)).data.projects.find(item => item.projectId === incoming.projectId);
        if (latest) throw Object.assign(databaseError('別のメンバーが先に登録しました。', 409, 'PROJECT_CONFLICT'), { latest });
        throw error;
      }
      return { project: (await load(env)).data.projects.find(item => item.projectId === incoming.projectId), created: true };
    }

    const nextRevision = Number(existing.revision) + 1;
    const update = env.DB.prepare(`UPDATE projects SET document = ?1, revision = ?2, updated_at = ?3, updated_by = ?4
      WHERE team_slug = ?5 AND project_id = ?6 AND revision = ?7`).bind(serialized, nextRevision, now, actor.login, slug, incoming.projectId, Number(existing.revision));
    const history = env.DB.prepare(`INSERT INTO project_history (team_slug, project_id, project_revision, updated_at, updated_by, progress_before, progress_after, status_before, status_after)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE EXISTS (SELECT 1 FROM projects WHERE team_slug = ?1 AND project_id = ?2 AND revision = ?3 AND updated_at = ?4 AND updated_by = ?5)`)
      .bind(slug, incoming.projectId, nextRevision, now, actor.login, existing.progress, incoming.progress, existing.status, incoming.status);
    const statements = [update, history];
    if (architecture) statements.push(env.DB.prepare(`INSERT INTO project_architectures (team_slug, project_id, document, revision, updated_at, updated_by)
      SELECT ?1, ?2, ?3, 1, ?4, ?5 WHERE EXISTS (SELECT 1 FROM projects WHERE team_slug = ?1 AND project_id = ?2 AND revision = ?6 AND updated_at = ?4)
      ON CONFLICT(team_slug, project_id) DO UPDATE SET document = excluded.document, revision = project_architectures.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(slug, incoming.projectId, JSON.stringify(architecture), now, actor.login, nextRevision));
    const results = await env.DB.batch(statements);
    if (!results[0].meta?.changes) {
      const latest = (await load(env)).data.projects.find(item => item.projectId === incoming.projectId);
      throw Object.assign(databaseError('共有先に新しい更新があります。最新内容を確認してください。', 409, 'PROJECT_CONFLICT'), { latest });
    }
    return { project: (await load(env)).data.projects.find(item => item.projectId === incoming.projectId), created: false };
  }

  async function listMembers(env) {
    const slug = teamSlug(env);
    const result = await env.DB.prepare('SELECT github_user_id AS id, github_login AS login, role, active, updated_at AS updatedAt FROM team_members WHERE team_slug = ?1 ORDER BY role, github_login COLLATE NOCASE').bind(slug).all();
    return result.results;
  }

  async function addMember(env, user, role = 'member') {
    const slug = teamSlug(env);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO team_members (team_slug, github_user_id, github_login, role, active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
      ON CONFLICT(team_slug, github_user_id) DO UPDATE SET github_login = excluded.github_login, role = excluded.role, active = 1, updated_at = excluded.updated_at`)
      .bind(slug, user.id, user.login, role === 'admin' ? 'admin' : 'member', now).run();
    return user;
  }

  async function removeMember(env, userId) {
    const slug = teamSlug(env);
    if (Number(userId) === Number(env.TEAM_ADMIN_GITHUB_ID)) throw databaseError('最初の管理者は削除できません。', 400);
    await env.DB.prepare('UPDATE team_members SET active = 0, updated_at = ?1 WHERE team_slug = ?2 AND github_user_id = ?3').bind(new Date().toISOString(), slug, Number(userId)).run();
  }

  return { currentUser, lookupUser, ensureAccess, load, updateProject, listMembers, addMember, removeMember };
}

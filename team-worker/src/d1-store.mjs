function databaseError(message, status = 500, code = '') {
  return Object.assign(new Error(message), { status, code });
}

function teamSlug(env, user = {}) {
  const slug = String(user.teamSlug || env.TEAM_SLUG || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw databaseError('TEAM_SLUGが正しくありません。');
  return slug;
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

export function createD1Store() {
  async function bootstrapUser(env, user) {
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw databaseError('メールアドレスを確認できません。', 401);
    const adminEmail = String(env.TEAM_ADMIN_EMAIL || '').trim().toLowerCase();
    const now = new Date().toISOString();
    if (email === adminEmail) {
      const slug = String(env.TEAM_SLUG || 'my-team');
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO teams (team_slug, name, owner_email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)').bind(slug, env.TEAM_NAME || slug, email, now),
        env.DB.prepare(`INSERT INTO access_members (team_slug, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'admin', 1, ?3, ?3)
          ON CONFLICT(team_slug, email) DO UPDATE SET role = 'admin', active = 1, updated_at = excluded.updated_at`).bind(slug, email, now)
      ]);
    }
    let membership = await env.DB.prepare(`SELECT m.team_slug AS teamSlug FROM access_members m
      WHERE m.email = ?1 AND m.active = 1 ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, m.created_at LIMIT 1`).bind(email).first();
    if (!membership) {
      const slug = `team-${crypto.randomUUID().slice(0, 12)}`;
      await createTeam(env, user, `${email.split('@')[0]}のチーム`, slug);
      membership = { teamSlug: slug };
    }
    return { ...user, email, teamSlug: membership.teamSlug };
  }

  async function listTeams(env, user) {
    const result = await env.DB.prepare(`SELECT t.team_slug AS teamSlug, t.name, m.role
      FROM access_members m JOIN teams t ON t.team_slug = m.team_slug
      WHERE m.email = ?1 AND m.active = 1 ORDER BY t.name COLLATE NOCASE`).bind(user.email).all();
    return result.results;
  }

  async function createTeam(env, user, nameInput, requestedSlug = '') {
    const name = String(nameInput || '').trim();
    if (!name || name.length > 80) throw databaseError('チーム名は1〜80文字で入力してください。', 400);
    const slug = requestedSlug || `team-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO teams (team_slug, name, owner_email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)').bind(slug, name, user.email, now),
      env.DB.prepare(`INSERT INTO access_members (team_slug, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'admin', 1, ?3, ?3)`).bind(slug, user.email, now)
    ]);
    return { teamSlug: slug, name, role: 'admin' };
  }

  async function ensureAccess(env, user, requiredRole = '') {
    const slug = teamSlug(env, user);
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw databaseError('メールアドレスを確認できません。', 401);
    const member = await env.DB.prepare('SELECT role, active FROM access_members WHERE team_slug = ?1 AND email = ?2').bind(slug, email).first();
    if (!member || member.active !== 1) throw databaseError('このチームのメンバーではありません。', 403, 'TEAM_ACCESS_DENIED');
    if (requiredRole === 'admin' && member.role !== 'admin') throw databaseError('チーム管理者の権限が必要です。', 403, 'TEAM_ADMIN_REQUIRED');
    return member;
  }

  async function load(env, user = {}) {
    const slug = teamSlug(env, user);
    const result = await env.DB.prepare(`SELECT p.*, a.document AS architecture_document, a.updated_at AS architecture_updated_at
      FROM projects p
      LEFT JOIN project_architectures a ON a.team_slug = p.team_slug AND a.project_id = p.project_id
      WHERE p.team_slug = ?1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`).bind(slug).all();
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
    const slug = teamSlug(env, actor);
    const actorName = actor.email || actor.login;
    const existingRow = await env.DB.prepare('SELECT * FROM projects WHERE team_slug = ?1 AND project_id = ?2').bind(slug, incoming.projectId).first();
    const deletedRow = existingRow?.deleted_at ? existingRow : null;
    const existing = existingRow && !deletedRow ? projectFromRow(existingRow) : null;
    const expected = String(expectedRevision || '');
    if (existing && (!expected || expected !== existing.revision)) throw Object.assign(databaseError('共有先に新しい更新があります。最新内容を確認してください。', 409, 'PROJECT_CONFLICT'), { latest: (await load(env, actor)).data.projects.find(item => item.projectId === incoming.projectId) });
    if (!existing && expected) throw databaseError('共有プロジェクトが見つかりません。', 409, 'PROJECT_MISSING');

    const now = new Date().toISOString();
    const architecture = incoming.architecture;
    const document = { ...incoming };
    delete document.architecture;
    const serialized = JSON.stringify(document);
    if (new TextEncoder().encode(serialized).length > 950000) throw databaseError('共有プロジェクトが上限（950KB）を超えます。', 413);

    if (!existing) {
      try {
        if (deletedRow) {
          const nextRevision = Number(deletedRow.revision) + 1;
          const statements = [
            env.DB.prepare(`UPDATE projects SET document = ?1, revision = ?2, deleted_at = NULL, deleted_by = NULL,
              shared_at = ?3, shared_by = ?4, updated_at = ?3, updated_by = ?4
              WHERE team_slug = ?5 AND project_id = ?6 AND deleted_at IS NOT NULL`).bind(serialized, nextRevision, now, actorName, slug, incoming.projectId),
            env.DB.prepare(`INSERT INTO project_history (team_slug, project_id, project_revision, updated_at, updated_by, progress_before, progress_after, status_before, status_after)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(slug, incoming.projectId, nextRevision, now, actorName, JSON.parse(deletedRow.document).progress, incoming.progress, JSON.parse(deletedRow.document).status, incoming.status)
          ];
          if (architecture) statements.push(env.DB.prepare(`INSERT INTO project_architectures (team_slug, project_id, document, revision, updated_at, updated_by)
            VALUES (?1, ?2, ?3, 1, ?4, ?5)
            ON CONFLICT(team_slug, project_id) DO UPDATE SET document = excluded.document, revision = project_architectures.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
            .bind(slug, incoming.projectId, JSON.stringify(architecture), now, actorName));
          await env.DB.batch(statements);
          return { project: (await load(env, actor)).data.projects.find(item => item.projectId === incoming.projectId), created: true, restored: true };
        }
        const statements = [
          env.DB.prepare(`INSERT INTO projects (team_slug, project_id, document, revision, shared_at, shared_by, updated_at, updated_by)
            VALUES (?1, ?2, ?3, 1, ?4, ?5, ?4, ?5)`).bind(slug, incoming.projectId, serialized, now, actorName),
          env.DB.prepare(`INSERT INTO project_history (team_slug, project_id, project_revision, updated_at, updated_by, progress_before, progress_after, status_before, status_after)
            VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5, ?6, ?6)`).bind(slug, incoming.projectId, now, actorName, incoming.progress, incoming.status)
        ];
        if (architecture) statements.push(env.DB.prepare(`INSERT INTO project_architectures (team_slug, project_id, document, revision, updated_at, updated_by)
          VALUES (?1, ?2, ?3, 1, ?4, ?5)`).bind(slug, incoming.projectId, JSON.stringify(architecture), now, actorName));
        await env.DB.batch(statements);
      } catch (error) {
        const latest = (await load(env, actor)).data.projects.find(item => item.projectId === incoming.projectId);
        if (latest) throw Object.assign(databaseError('別のメンバーが先に登録しました。', 409, 'PROJECT_CONFLICT'), { latest });
        throw error;
      }
      return { project: (await load(env, actor)).data.projects.find(item => item.projectId === incoming.projectId), created: true };
    }

    const nextRevision = Number(existing.revision) + 1;
    const update = env.DB.prepare(`UPDATE projects SET document = ?1, revision = ?2, updated_at = ?3, updated_by = ?4
      WHERE team_slug = ?5 AND project_id = ?6 AND revision = ?7`).bind(serialized, nextRevision, now, actorName, slug, incoming.projectId, Number(existing.revision));
    const history = env.DB.prepare(`INSERT INTO project_history (team_slug, project_id, project_revision, updated_at, updated_by, progress_before, progress_after, status_before, status_after)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE EXISTS (SELECT 1 FROM projects WHERE team_slug = ?1 AND project_id = ?2 AND revision = ?3 AND updated_at = ?4 AND updated_by = ?5)`)
      .bind(slug, incoming.projectId, nextRevision, now, actorName, existing.progress, incoming.progress, existing.status, incoming.status);
    const statements = [update, history];
    if (architecture) statements.push(env.DB.prepare(`INSERT INTO project_architectures (team_slug, project_id, document, revision, updated_at, updated_by)
      SELECT ?1, ?2, ?3, 1, ?4, ?5 WHERE EXISTS (SELECT 1 FROM projects WHERE team_slug = ?1 AND project_id = ?2 AND revision = ?6 AND updated_at = ?4)
      ON CONFLICT(team_slug, project_id) DO UPDATE SET document = excluded.document, revision = project_architectures.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(slug, incoming.projectId, JSON.stringify(architecture), now, actorName, nextRevision));
    const results = await env.DB.batch(statements);
    if (!results[0].meta?.changes) {
      const latest = (await load(env, actor)).data.projects.find(item => item.projectId === incoming.projectId);
      throw Object.assign(databaseError('共有先に新しい更新があります。最新内容を確認してください。', 409, 'PROJECT_CONFLICT'), { latest });
    }
    return { project: (await load(env, actor)).data.projects.find(item => item.projectId === incoming.projectId), created: false };
  }

  async function deleteProject(env, actor, projectId, expectedRevision) {
    const slug = teamSlug(env, actor);
    const row = await env.DB.prepare('SELECT revision, shared_by FROM projects WHERE team_slug = ?1 AND project_id = ?2 AND deleted_at IS NULL').bind(slug, projectId).first();
    if (!row) throw databaseError('共有プロジェクトが見つかりません。', 404, 'PROJECT_MISSING');
    const member = await env.DB.prepare('SELECT role FROM access_members WHERE team_slug = ?1 AND email = ?2 AND active = 1').bind(slug, actor.email).first();
    if (member?.role !== 'admin' && String(row.shared_by).toLowerCase() !== String(actor.email).toLowerCase()) {
      throw databaseError('共有を解除できるのはチーム管理者または共有した本人だけです。', 403, 'PROJECT_DELETE_DENIED');
    }
    const now = new Date().toISOString();
    const result = await env.DB.prepare(`UPDATE projects
      SET deleted_at = ?1, deleted_by = ?2, revision = revision + 1, updated_at = ?1, updated_by = ?2
      WHERE team_slug = ?3 AND project_id = ?4 AND revision = ?5 AND deleted_at IS NULL`)
      .bind(now, actor.email, slug, projectId, Number(expectedRevision)).run();
    if (result.meta?.changes) return { removed: true, projectId };
    const latest = (await load(env, actor)).data.projects.find(item => item.projectId === projectId);
    if (!latest) throw databaseError('共有プロジェクトが見つかりません。', 404, 'PROJECT_MISSING');
    throw Object.assign(databaseError('共有先に新しい更新があります。最新内容を確認してください。', 409, 'PROJECT_CONFLICT'), { latest });
  }

  async function listMembers(env, actor) {
    const slug = teamSlug(env, actor);
    const result = await env.DB.prepare('SELECT id, email, role, active, updated_at AS updatedAt FROM access_members WHERE team_slug = ?1 ORDER BY role, email COLLATE NOCASE').bind(slug).all();
    return result.results;
  }

  async function addMember(env, actor, emailInput, role = 'member') {
    const slug = teamSlug(env, actor);
    const email = String(emailInput || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw databaseError('メールアドレスが正しくありません。', 400);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO access_members (team_slug, email, role, active, created_at, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4, ?4)
      ON CONFLICT(team_slug, email) DO UPDATE SET role = excluded.role, active = 1, updated_at = excluded.updated_at`)
      .bind(slug, email, role === 'admin' ? 'admin' : 'member', now).run();
    return { email };
  }

  async function removeMember(env, actor, memberId) {
    const slug = teamSlug(env, actor);
    const member = await env.DB.prepare('SELECT email, role, active FROM access_members WHERE team_slug = ?1 AND id = ?2').bind(slug, Number(memberId)).first();
    if (member?.email?.toLowerCase() === String(env.TEAM_ADMIN_EMAIL || '').toLowerCase()) throw databaseError('最初の管理者は削除できません。', 400);
    if (member?.active === 1 && member?.role === 'admin') {
      const admins = await env.DB.prepare("SELECT COUNT(*) AS count FROM access_members WHERE team_slug = ?1 AND role = 'admin' AND active = 1").bind(slug).first();
      if (Number(admins?.count || 0) <= 1) throw databaseError('チームには最低1人の管理者が必要です。', 400, 'LAST_ADMIN');
    }
    await env.DB.prepare('UPDATE access_members SET active = 0, updated_at = ?1 WHERE team_slug = ?2 AND id = ?3').bind(new Date().toISOString(), slug, Number(memberId)).run();
  }

  return { bootstrapUser, listTeams, createTeam, ensureAccess, load, updateProject, deleteProject, listMembers, addMember, removeMember };
}

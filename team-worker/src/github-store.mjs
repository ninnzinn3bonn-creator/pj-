const API_VERSION = '2022-11-28';

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUtf8Base64(value) {
  const binary = atob(String(value).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function repositoryConfig(env) {
  const match = String(env.GITHUB_REPOSITORY || '').match(/^([^/]+)\/([^/]+)$/);
  if (!match) throw new Error('GITHUB_REPOSITORYをOWNER/REPOSITORY形式で設定してください。');
  const slug = String(env.TEAM_SLUG || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('TEAM_SLUGは英小文字・数字・ハイフンで設定してください。');
  return { owner: match[1], repository: match[2], branch: env.GITHUB_BRANCH || 'main', path: `teams/${slug}/projects.json` };
}

async function github(fetchImpl, token, pathname, options = {}) {
  const response = await fetchImpl(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'project-manager-team-worker',
      'X-GitHub-Api-Version': API_VERSION,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  return { response, data };
}

export function createGitHubStore(fetchImpl = fetch) {
  async function currentUser(token) {
    const result = await github(fetchImpl, token, '/user');
    if (!result.response.ok) throw Object.assign(new Error('GitHubユーザーを確認できません。'), { status: 401 });
    return { login: result.data.login, id: result.data.id, avatarUrl: result.data.avatar_url };
  }

  async function load(env, token) {
    const config = repositoryConfig(env);
    const repository = await github(fetchImpl, token, `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`);
    if (!repository.response.ok || repository.data?.private !== true || repository.data?.permissions?.push !== true) {
      throw Object.assign(new Error('チーム用の非公開リポジトリへの編集権限が必要です。'), { status: 403 });
    }
    const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents/${config.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(config.branch)}`;
    const result = await github(fetchImpl, token, endpoint);
    if (result.response.status === 404) {
      return { sha: '', data: { schemaVersion: 1, team: env.TEAM_SLUG, projects: [] }, config };
    }
    if (result.response.status === 403) throw Object.assign(new Error('このチームの非公開データリポジトリへアクセスできません。'), { status: 403 });
    if (!result.response.ok) throw Object.assign(new Error(result.data?.message || 'GitHubから共有データを取得できません。'), { status: 502 });
    let data;
    try { data = JSON.parse(decodeUtf8Base64(result.data.content)); } catch { throw Object.assign(new Error('GitHub上の共有データJSONが壊れています。'), { status: 502 }); }
    if (data.schemaVersion !== 1 || !Array.isArray(data.projects)) throw Object.assign(new Error('共有データの形式が正しくありません。'), { status: 502 });
    return { sha: result.data.sha, data, config };
  }

  async function save(env, token, loaded, data, actor) {
    const { config } = loaded;
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (new TextEncoder().encode(serialized).length > 950000) throw Object.assign(new Error('共有データが上限（950KB）を超えます。概念図や履歴の量を整理してください。'), { status: 413 });
    const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents/${config.path.split('/').map(encodeURIComponent).join('/')}`;
    const body = {
      message: `project-manager: update by @${actor}`,
      content: encodeUtf8Base64(serialized),
      branch: config.branch,
      ...(loaded.sha ? { sha: loaded.sha } : {})
    };
    const result = await github(fetchImpl, token, endpoint, { method: 'PUT', body: JSON.stringify(body) });
    if (result.response.status === 409 || result.response.status === 422) {
      throw Object.assign(new Error('別のメンバーが先に更新しました。'), { status: 409, code: 'REPOSITORY_CONFLICT' });
    }
    if (!result.response.ok) throw Object.assign(new Error(result.data?.message || 'GitHubへ共有データを保存できません。'), { status: 502 });
    return result.data.content?.sha || '';
  }

  return { currentUser, load, save };
}

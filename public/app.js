'use strict';

const STATUS_LABELS = {
  idea: '構想',
  planning: '設計中',
  development: '開発中',
  testing: 'テスト中',
  release_ready: '公開準備完了',
  published: '公開済み',
  update_pending: 'アップデート待ち',
  blocked: '問題発生',
  paused: '一時停止',
  archived: '終了・保管'
};

const STATUS_COLORS = {
  idea: '#6c7075',
  planning: '#87651b',
  development: '#17699a',
  testing: '#6d4f8b',
  release_ready: '#357247',
  published: '#23763a',
  update_pending: '#a05a12',
  blocked: '#b1222a',
  paused: '#7b5255',
  archived: '#555b61'
};

const UPDATE_SOURCE_LABELS = {
  web: 'Web',
  'web-ai': 'Web・AI取込',
  cli: 'CLI',
  'codex-skill': 'Codexスキル',
  team: 'チーム共有',
  backup: 'バックアップ'
};

const state = {
  projects: [],
  localProjects: [],
  teamProjects: [],
  editingProjectId: null,
  aiText: '',
  aiPreview: null,
  aiExpectedMode: '',
  aiExpectedProjectId: '',
  backupData: null,
  backupPreview: null,
  confirmResolve: null,
  architectureMetaByProject: new Map(),
  architectureDocument: null,
  architectureViewer: null,
  architectureImportData: null,
  architectureImportPreview: null,
  architectureLoadSequence: 0
};

const elements = {
  updateBanner: document.querySelector('#update-banner'),
  updateTitle: document.querySelector('#update-title'),
  updateNote: document.querySelector('#update-note'),
  updateDetails: document.querySelector('#update-details'),
  updateDownload: document.querySelector('#update-download'),
  listView: document.querySelector('#list-view'),
  detailView: document.querySelector('#detail-view'),
  rows: document.querySelector('#project-rows'),
  empty: document.querySelector('#empty-state'),
  filteredEmpty: document.querySelector('#filtered-empty-state'),
  counts: document.querySelector('#status-counts'),
  search: document.querySelector('#search-input'),
  statusFilter: document.querySelector('#status-filter'),
  ownerFilter: document.querySelector('#owner-filter'),
  sort: document.querySelector('#sort-select'),
  message: document.querySelector('#message'),
  detailContent: document.querySelector('#detail-content'),
  detailUpdated: document.querySelector('#detail-updated'),
  architectureView: document.querySelector('#architecture-view'),
  architectureContent: document.querySelector('#architecture-content'),
  architectureUpdated: document.querySelector('#architecture-updated'),
  deleteSamples: document.querySelector('#delete-samples'),
  manualDialog: document.querySelector('#manual-dialog'),
  manualForm: document.querySelector('#manual-form'),
  manualTitle: document.querySelector('#manual-title'),
  manualError: document.querySelector('#manual-error'),
  aiDialog: document.querySelector('#ai-dialog'),
  aiTitle: document.querySelector('#ai-title'),
  aiGuidance: document.querySelector('#ai-guidance'),
  aiTextArea: document.querySelector('#ai-text'),
  aiError: document.querySelector('#ai-error'),
  aiPreviewBox: document.querySelector('#ai-preview'),
  aiCommit: document.querySelector('#ai-commit'),
  backupDialog: document.querySelector('#backup-dialog'),
  backupFile: document.querySelector('#backup-file'),
  backupError: document.querySelector('#backup-error'),
  backupPreviewBox: document.querySelector('#backup-preview'),
  backupCommit: document.querySelector('#backup-commit'),
  cliDialog: document.querySelector('#cli-dialog'),
  cliUrl: document.querySelector('#cli-url'),
  cliService: document.querySelector('#cli-service'),
  cliVersion: document.querySelector('#cli-version'),
  cliBasicCommand: document.querySelector('#cli-basic-command'),
  cliJsonCommand: document.querySelector('#cli-json-command'),
  cliLinkCommand: document.querySelector('#cli-link-command'),
  cliError: document.querySelector('#cli-error'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  confirmMessage: document.querySelector('#confirm-message'),
  architectureImportDialog: document.querySelector('#architecture-import-dialog'),
  architectureImportFile: document.querySelector('#architecture-import-file'),
  architectureImportText: document.querySelector('#architecture-import-text'),
  architectureTemplateButton: document.querySelector('#architecture-template-button'),
  architectureImportError: document.querySelector('#architecture-import-error'),
  architectureImportPreview: document.querySelector('#architecture-import-preview'),
  architectureImportCommit: document.querySelector('#architecture-import-commit-button')
};

async function checkForUpdate() {
  try {
    const update = await api('/api/update');
    if (!update.available || localStorage.getItem('pm-update-dismissed') === update.latestVersion) return;
    elements.updateTitle.textContent = `新しいバージョン v${update.latestVersion} が利用できます`;
    elements.updateNote.textContent = `現在 v${update.currentVersion}。ダウンロード後にZIPを展開してください。dataフォルダは上書きしないでください。`;
    elements.updateDetails.href = update.releaseUrl;
    elements.updateDownload.href = update.downloadUrl;
    elements.updateDownload.dataset.version = update.latestVersion;
    elements.updateBanner.hidden = false;
  } catch {
    // 更新確認の失敗でローカル台帳の利用を妨げない。
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value));
}

function statusStyle(status) {
  return `--status-color:${STATUS_COLORS[status] || '#555b61'}`;
}

function statusOptions(selected = '') {
  return Object.entries(STATUS_LABELS)
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
}

function sourceLabel(source) {
  return UPDATE_SOURCE_LABELS[source] || '記録なし';
}

function listText(items) {
  return Array.isArray(items) && items.length ? items.join('\n') : '';
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function splitTags(value) {
  return String(value || '').split(/[,、\n]/).map((item) => item.trim()).filter(Boolean);
}

function renderTaskList(items) {
  if (!Array.isArray(items) || !items.length) return '<p class="none">なし</p>';
  return `<ul class="task-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function formatCompareValue(value, key) {
  if (Array.isArray(value)) return value.length ? value.join('\n') : 'なし';
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'status') return STATUS_LABELS[value] || value;
  if (key === 'progress') return `${value}%`;
  return String(value);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `通信に失敗しました（${response.status}）。`);
    error.status = response.status;
    error.details = data.details || [];
    throw error;
  }
  return data;
}

let messageTimer;
function showMessage(text, isError = false) {
  clearTimeout(messageTimer);
  elements.message.textContent = text;
  elements.message.classList.toggle('error', isError);
  elements.message.hidden = false;
  messageTimer = setTimeout(() => { elements.message.hidden = true; }, 5000);
}

function showInlineError(element, error) {
  const uniqueDetails = Array.isArray(error.details)
    ? [...new Set(error.details.map((detail) => String(detail)).filter((detail) => detail && detail !== error.message))]
    : [];
  const details = uniqueDetails.length ? `\n${uniqueDetails.join('\n')}` : '';
  element.textContent = `${error.message}${details}`;
  element.hidden = false;
}

function clearInlineError(element) {
  element.textContent = '';
  element.hidden = true;
}

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    state.localProjects = data.projects;
    await loadTeamProjects({ quiet: true });
    mergeProjects();
    updateOwnerFilter();
    renderList();
    renderRoute();
  } catch (error) {
    showMessage(error.message, true);
  }
}

function teamCacheKey(config) {
  try { return `pm-team-cache:${new URL(config.url).origin}:${config.team || 'unselected'}`; } catch { return 'pm-team-cache'; }
}

function teamRevisionKey(config, projectId) {
  try { return `pm-team-revision:${new URL(config.url).origin}:${config.team || 'unselected'}:${projectId}`; } catch { return `pm-team-revision:${projectId}`; }
}
function teamSyncKey(config, projectId) { return `${teamRevisionKey(config, projectId)}:sync`; }
function loadTeamSyncMeta(config, projectId) { try { return JSON.parse(localStorage.getItem(teamSyncKey(config, projectId)) || 'null'); } catch { return null; } }
function saveTeamSyncMeta(config, local, team) {
  localStorage.setItem(teamSyncKey(config, local.projectId), JSON.stringify({ localFingerprint: TeamSync.fingerprint(local), teamFingerprint: TeamSync.fingerprint(team), teamRevision: team.revision, syncedAt: new Date().toISOString() }));
  localStorage.setItem(teamRevisionKey(config, local.projectId), team.revision);
}

function loadCachedTeamProjects(config) {
  try {
    const cached = JSON.parse(localStorage.getItem(teamCacheKey(config)) || '{}');
    return Array.isArray(cached.projects) ? cached.projects : [];
  } catch { return []; }
}

function mergeProjects() {
  const config = teamConfig();
  const localById = new Map(state.localProjects.map(project => [project.projectId, project]));
  const teamById = new Map(state.teamProjects.map(project => [project.projectId, project]));
  state.projects = state.localProjects.map(local => {
    const shared = teamById.get(local.projectId);
    if (shared) {
      const result = TeamSync.classify(local, shared, loadTeamSyncMeta(config, local.projectId));
      if (result.state === 'synced') saveTeamSyncMeta(config, local, shared);
      const selected = result.state === 'team-ahead' ? shared : local;
      return { ...selected, _localVersion: local, _teamVersion: shared, _team: true, _local: true, _syncState: result.state };
    }
    return shared
      ? { ...shared, lastUpdateSource: 'team', _team: true, _local: true, _syncState: 'synced' }
      : { ...local, _team: false, _local: true, _syncState: 'local' };
  });
  for (const shared of state.teamProjects) {
    if (!localById.has(shared.projectId)) state.projects.push({ ...shared, lastUpdateSource: 'team', _team: true, _local: false, _syncState: 'team-only' });
  }
}

function syncLabel(project) {
  return { synced: 'チーム共有・同期済み', 'local-ahead': 'チーム未反映', 'team-ahead': 'チーム更新あり', conflict: '競合・確認必要', unverified: '同期確認が必要', 'team-only': 'チームから追加' }[project._syncState] || 'チーム共有';
}

async function loadTeamProjects({ quiet = false } = {}) {
  let config = teamConfig();
  const button = document.querySelector('#team-sync-button');
  button.hidden = !config.url || !config.token;
  if (!config.url || !config.token) {
    state.teamProjects = [];
    return;
  }
  try {
    const data = await teamApi(config, '/api/projects');
    if (data.team && config.team !== data.team) {
      config = { ...config, team: data.team };
      localStorage.setItem('pm-team', JSON.stringify(config));
    }
    state.teamProjects = data.projects || [];
    localStorage.setItem(teamCacheKey(config), JSON.stringify({ fetchedAt: new Date().toISOString(), projects: state.teamProjects }));
    button.dataset.state = 'ready';
  } catch (error) {
    state.teamProjects = loadCachedTeamProjects(config);
    button.dataset.state = 'offline';
    if (!quiet) showMessage(`チーム同期に失敗しました。保存済み表示を使用します: ${error.message}`, true);
  }
}

async function syncTeamProjects() {
  const button = document.querySelector('#team-sync-button');
  button.disabled = true;
  try {
    await loadTeamProjects();
    mergeProjects();
    updateOwnerFilter();
    renderList();
    renderRoute();
    if (button.dataset.state !== 'offline') showMessage('チームの最新データを取り込みました。');
  } finally { button.disabled = false; }
}

function updateOwnerFilter() {
  const selected = elements.ownerFilter.value;
  const owners = [...new Set(state.projects.map((item) => item.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  elements.ownerFilter.innerHTML = `<option value="">すべて</option>${owners.map((owner) => `<option value="${escapeHtml(owner)}">${escapeHtml(owner)}</option>`).join('')}`;
  if (owners.includes(selected)) elements.ownerFilter.value = selected;
}

function renderCounts() {
  const counts = state.projects.reduce((result, project) => {
    result[project.status] = (result[project.status] || 0) + 1;
    return result;
  }, {});
  const parts = [`全体 ${state.projects.length}`];
  Object.entries(STATUS_LABELS).forEach(([status, label]) => {
    if (counts[status]) parts.push(`${label} ${counts[status]}`);
  });
  elements.counts.textContent = parts.join(' / ');
}

function filteredProjects() {
  const search = elements.search.value.trim().toLocaleLowerCase('ja');
  const status = elements.statusFilter.value;
  const owner = elements.ownerFilter.value;
  const projects = state.projects.filter((project) => {
    const haystack = [project.name, project.projectId, project.owner, project.summary, ...(project.tags || [])].join(' ').toLocaleLowerCase('ja');
    return (!search || haystack.includes(search)) && (!status || project.status === status) && (!owner || project.owner === owner);
  });
  const [field, direction] = elements.sort.value.split('_');
  projects.sort((a, b) => {
    const first = field === 'updated' ? Date.parse(a.updatedAt) || 0 : a.progress;
    const second = field === 'updated' ? Date.parse(b.updatedAt) || 0 : b.progress;
    return direction === 'desc' ? second - first : first - second;
  });
  return projects;
}

function renderList() {
  renderCounts();
  const projects = filteredProjects();
  elements.rows.innerHTML = projects.map((project) => {
    const url = project.appUrl || project.developmentUrl;
    return `
      <tr class="${project._team ? 'shared-project' : ''}" tabindex="0" data-project-id="${escapeHtml(project.projectId)}" aria-label="${escapeHtml(project.name)}の詳細を開く">
        <td class="project-name">
          ${escapeHtml(project.name)} ${project._team ? `<span class="team-badge sync-${escapeHtml(project._syncState)}">${escapeHtml(syncLabel(project))}</span>` : ''}
          <span class="project-id-row">
            <span class="project-id">${escapeHtml(project.projectId)}</span>
            <button type="button" class="copy-id-button" data-copy-project-id="${escapeHtml(project.projectId)}" aria-label="${escapeHtml(project.name)}のプロジェクトIDをコピー" title="プロジェクトIDをコピー">コピー</button>
          </span>
        </td>
        <td class="url-cell">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(url)}</a>` : '<span class="url-empty">未登録</span>'}</td>
        <td><select class="status-select" data-status-id="${escapeHtml(project.projectId)}" aria-label="${escapeHtml(project.name)}の状態" style="${statusStyle(project.status)}">${statusOptions(project.status)}</select></td>
        <td class="progress-cell">
          <div class="progress-line" style="${statusStyle(project.status)}">
            <span class="progress-value">${project.progress}%</span>
            <div class="progress-track" role="progressbar" aria-label="進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${project.progress}"><div class="progress-fill" style="--progress:${project.progress}%"></div></div>
          </div>
        </td>
        <td>${escapeHtml(project.owner || '—')}</td>
        <td class="source-cell">${escapeHtml(sourceLabel(project.lastUpdateSource))}</td>
        <td class="date-cell">${escapeHtml(formatDate(project.updatedAt))}</td>
      </tr>`;
  }).join('');

  elements.empty.hidden = state.projects.length !== 0;
  elements.filteredEmpty.hidden = state.projects.length === 0 || projects.length !== 0;
  elements.deleteSamples.hidden = !state.projects.some((project) => project.isSample === true);
}

function detailLink(label, url) {
  return url
    ? `<a class="detail-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`
    : '<span class="none">未登録</span>';
}

function architectureBasePath(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/architecture`;
}

function normalizeArchitectureMeta(raw = {}) {
  const meta = raw.meta || raw.architecture_meta || raw.artifact || raw;
  const aliases = {
    missing: 'missing', none: 'missing', not_found: 'missing', absent: 'missing',
    ready: 'ready', available: 'ready', created: 'ready', complete: 'ready',
    stale: 'stale', outdated: 'stale', update_pending: 'stale',
    error: 'error', failed: 'error', invalid: 'error'
  };
  const rawState = String(meta.state || meta.status || '').toLowerCase();
  let status = aliases[rawState];
  if (!status) status = meta.exists === false ? 'missing' : meta.exists === true ? 'ready' : 'missing';
  const counts = meta.counts || meta.summary || {};
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    status,
    hasValidDocument: Boolean(meta.has_valid_document ?? meta.hasValidDocument ?? ['ready', 'stale'].includes(status)),
    analyzedAt: meta.analyzed_at || meta.analyzedAt || meta.generated_at || meta.generatedAt || meta.updated_at || meta.updatedAt || '',
    revision: meta.revision || meta.etag || meta.source_revision || meta.sourceRevision || '',
    lastError: meta.last_error || meta.lastError || meta.error || '',
    counts: {
      components: number(counts.components ?? counts.nodes ?? meta.component_count ?? meta.componentCount),
      edges: number(counts.edges ?? meta.edge_count ?? meta.edgeCount),
      flows: number(counts.flows ?? meta.flow_count ?? meta.flowCount)
    }
  };
}

function architectureStatusPresentation(status) {
  return {
    loading: { label: '確認中', button: '概念図を確認', description: '概念図の状態を確認しています。' },
    missing: { label: '未作成', button: '概念図を作成', description: '概念図はまだ登録されていません。CodexまたはJSONから作成できます。' },
    ready: { label: '作成済み', button: '概念図を見る', description: 'コンポーネント、依存関係、主要フローを確認できます。' },
    stale: { label: '更新あり', button: '概念図を確認・更新', description: '保存後にプロジェクトが更新されています。現在の図を確認し、必要に応じて再解析してください。' },
    error: { label: 'エラー', button: '概念図を再確認', description: '直近の概念図処理で問題が発生しました。以前の図があれば引き続き閲覧できます。' }
  }[status] || { label: '未作成', button: '概念図を作成', description: '概念図はまだ登録されていません。' };
}

function renderArchitectureCard(project, meta = { status: 'loading', counts: {} }) {
  const card = elements.detailContent.querySelector('[data-architecture-card]');
  if (!card || card.dataset.projectId !== project.projectId) return;
  const presentation = architectureStatusPresentation(meta.status);
  const counts = meta.counts || {};
  const countText = meta.status === 'loading' || meta.status === 'missing'
    ? ''
    : `${counts.components || 0}コンポーネント / ${counts.edges || 0}接続 / ${counts.flows || 0}フロー`;
  card.innerHTML = `
    <div class="architecture-card-heading">
      <h3>プロジェクト概念図</h3>
      <span class="architecture-state ${escapeHtml(meta.status)}">${escapeHtml(presentation.label)}</span>
    </div>
    <p>${escapeHtml(presentation.description)}</p>
    ${meta.lastError ? `<p class="architecture-card-meta">${escapeHtml(meta.lastError)}</p>` : ''}
    ${countText || meta.analyzedAt ? `<p class="architecture-card-meta">${escapeHtml([countText, meta.analyzedAt ? `解析 ${formatDate(meta.analyzedAt)}` : ''].filter(Boolean).join(' / '))}</p>` : ''}
    <button type="button" data-detail-action="architecture"${meta.status === 'loading' ? ' aria-busy="true"' : ''}>${escapeHtml(presentation.button)}</button>`;
}

async function loadArchitectureMeta(project, { force = false } = {}) {
  if (!force && state.architectureMetaByProject.has(project.projectId)) {
    renderArchitectureCard(project, state.architectureMetaByProject.get(project.projectId));
  }
  if (project._team && !project._local) {
    const architecture = project._teamVersion?.architecture || project.architecture;
    const meta = architecture
      ? normalizeArchitectureMeta({
          status: 'ready', exists: true,
          analyzedAt: architecture.document?.analyzed_at || project.architectureUpdatedAt || project.updatedAt,
          revision: project._teamVersion?.revision || project.revision,
          counts: { components: architecture.components?.length, edges: architecture.edges?.length, flows: architecture.flows?.length }
        })
      : normalizeArchitectureMeta({ status: 'missing', exists: false });
    state.architectureMetaByProject.set(project.projectId, meta);
    renderArchitectureCard(project, meta);
    return meta;
  }
  try {
    const raw = await api(`${architectureBasePath(project.projectId)}/meta`);
    const meta = normalizeArchitectureMeta(raw);
    state.architectureMetaByProject.set(project.projectId, meta);
    renderArchitectureCard(project, meta);
    return meta;
  } catch (error) {
    const sharedArchitecture = project._teamVersion?.architecture;
    const meta = error.status === 404 && sharedArchitecture
      ? normalizeArchitectureMeta({
          status: 'ready', exists: true,
          analyzedAt: sharedArchitecture.document?.analyzed_at || project._teamVersion.architectureUpdatedAt || project._teamVersion.updatedAt,
          revision: project._teamVersion.revision,
          counts: { components: sharedArchitecture.components?.length, edges: sharedArchitecture.edges?.length, flows: sharedArchitecture.flows?.length }
        })
      : error.status === 404
        ? normalizeArchitectureMeta({ status: 'missing', exists: false })
      : normalizeArchitectureMeta({ status: 'error', last_error: error.message, has_valid_document: false });
    state.architectureMetaByProject.set(project.projectId, meta);
    renderArchitectureCard(project, meta);
    return meta;
  }
}

function renderDetail(project) {
  elements.detailUpdated.textContent = `最終更新 ${formatDate(project.updatedAt)}`;
  const history = [...(project.history || [])].reverse();
  elements.detailContent.innerHTML = `
    <div class="detail-header">
      <div>
        <h2 id="detail-title">${escapeHtml(project.name)}</h2>
        <div class="detail-id-row">
          <p class="detail-id">${escapeHtml(project.projectId)}</p>
          <button type="button" class="copy-id-button" data-copy-project-id="${escapeHtml(project.projectId)}" aria-label="${escapeHtml(project.name)}のプロジェクトIDをコピー">IDをコピー</button>
        </div>
      </div>
      <div class="detail-actions">
        ${project._team ? `<span class="team-badge detail-team-badge sync-${escapeHtml(project._syncState)}">${escapeHtml(syncLabel(project))}</span>` : '<button type="button" data-detail-action="share">チームへ共有</button>'}
        ${['local-ahead','conflict','unverified'].includes(project._syncState) ? '<button type="button" class="primary" data-detail-action="sync-to-team">チームへ反映</button>' : ''}
        ${project._syncState === 'team-ahead' ? '<button type="button" class="primary" data-detail-action="sync-from-team">チーム更新を取り込む</button>' : ''}
        ${project._team && project._local && project._syncState !== 'synced' ? '<button type="button" data-detail-action="compare-team">差分を確認</button>' : ''}
        ${project._local ? '<button type="button" data-detail-action="ai-update">AI出力で更新</button>' : ''}
        <button type="button" data-detail-action="edit" class="primary">手動編集</button>
        <details class="action-menu">
          <summary>その他の操作</summary>
          <div class="action-menu-panel">
            ${project.appUrl ? `<a class="button-link" href="${escapeHtml(project.appUrl)}" target="_blank" rel="noopener noreferrer">URLを開く</a>` : ''}
            ${project.adminUrl ? `<a class="button-link" href="${escapeHtml(project.adminUrl)}" target="_blank" rel="noopener noreferrer">管理者サイトを開く</a>` : ''}
            ${project.repositoryUrl ? `<a class="button-link" href="${escapeHtml(project.repositoryUrl)}" target="_blank" rel="noopener noreferrer">リポジトリを開く</a>` : ''}
            <button type="button" data-detail-action="copy-update">更新用プロンプトをコピー</button>
            ${project._team ? '<button type="button" data-detail-action="unshare" class="danger-text">チーム共有を解除</button>' : ''}
            ${project._local ? '<button type="button" data-detail-action="delete" class="danger-text">ローカルから削除</button>' : ''}
          </div>
        </details>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-main">
        <table class="definition-table">
          <tbody>
            <tr><th scope="row">アプリURL</th><td>${detailLink('アプリURL', project.appUrl)}</td></tr>
            <tr><th scope="row">管理者サイトURL</th><td>${detailLink('管理者サイトURL', project.adminUrl)}</td></tr>
            <tr><th scope="row">リポジトリURL</th><td>${detailLink('リポジトリURL', project.repositoryUrl)}</td></tr>
            <tr><th scope="row">開発環境URL</th><td>${detailLink('開発環境URL', project.developmentUrl)}</td></tr>
            <tr><th scope="row">管理状態</th><td><span class="status-text" style="${statusStyle(project.status)}">${escapeHtml(STATUS_LABELS[project.status] || project.status)}</span></td></tr>
            <tr><th scope="row">進捗</th><td><div class="progress-line detail-progress" style="${statusStyle(project.status)}"><span class="progress-value">${project.progress}%</span><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${project.progress}"><div class="progress-fill" style="--progress:${project.progress}%"></div></div></div></td></tr>
            <tr><th scope="row">担当者</th><td>${escapeHtml(project.owner || '—')}</td></tr>
            <tr><th scope="row">タグ</th><td><div class="tag-list">${project.tags.length ? project.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') : '<span class="none">なし</span>'}</div></td></tr>
            <tr><th scope="row">最終更新元</th><td>${escapeHtml(sourceLabel(project.lastUpdateSource))}</td></tr>
            <tr><th scope="row">作成日時</th><td>${escapeHtml(formatDate(project.createdAt))}</td></tr>
            <tr><th scope="row">最終更新日時</th><td>${escapeHtml(formatDate(project.updatedAt))}</td></tr>
          </tbody>
        </table>

        <section class="architecture-card" data-architecture-card data-project-id="${escapeHtml(project.projectId)}" aria-label="プロジェクト概念図">
          <p class="architecture-card-meta">概念図の状態を確認しています。</p>
        </section>

        <h3>現在の状況</h3>
        <p>${project.summary ? escapeHtml(project.summary) : '<span class="none">記載なし</span>'}</p>
        <h3>現在作業中の項目</h3>
        ${renderTaskList(project.currentTasks)}
        <h3>次に行う作業</h3>
        ${renderTaskList(project.nextTasks)}
        <h3>問題・ブロッカー</h3>
        ${renderTaskList(project.blockers)}
      </div>
      <aside class="detail-side">
        <h3>更新履歴</h3>
        ${history.length ? `
          <div class="history-wrap"><table class="history-table">
            <thead><tr><th>更新日時</th><th>更新元</th><th>進捗</th><th>状態</th><th>更新後の概要</th></tr></thead>
            <tbody>${history.map((item) => `<tr><td>${escapeHtml(formatDate(item.updatedAt))}</td><td title="${escapeHtml(item.requestId || '')}">${escapeHtml(sourceLabel(item.source))}</td><td>${item.progressBefore}% → ${item.progressAfter}%</td><td>${escapeHtml(STATUS_LABELS[item.statusBefore] || item.statusBefore)} → ${escapeHtml(STATUS_LABELS[item.statusAfter] || item.statusAfter)}</td><td>${escapeHtml(item.summaryAfter || '—')}</td></tr>`).join('')}</tbody>
          </table></div>` : '<p class="none">更新履歴はまだありません。</p>'}
      </aside>
    </div>`;
  renderArchitectureCard(project, state.architectureMetaByProject.get(project.projectId) || { status: 'loading', counts: {} });
  void loadArchitectureMeta(project);
}

function currentRoute() {
  if (!location.hash || location.hash === '#') return { name: 'list', projectId: '' };
  const match = location.hash.match(/^#\/project\/([^/]+)(?:\/(architecture))?$/);
  if (!match) return { name: 'unknown', projectId: '' };
  try {
    return { name: match[2] === 'architecture' ? 'architecture' : 'detail', projectId: decodeURIComponent(match[1]) };
  } catch {
    return { name: 'unknown', projectId: '' };
  }
}

function currentDetailId() {
  return currentRoute().projectId;
}

function destroyArchitectureViewer() {
  if (state.architectureViewer) state.architectureViewer.destroy();
  state.architectureViewer = null;
  state.architectureDocument = null;
}

function architecturePrompt() {
  return '概念図に反映';
}

function architectureJsonPrompt(project) {
  const projectId = JSON.stringify(project.projectId);
  const projectName = JSON.stringify(project.name);
  return [
    `プロジェクト「${project.name}」（project_id: ${project.projectId}）のコードリポジトリ／ディレクトリ全体を詳細に分析してください。`,
    '',
    'README、ソースコード、設定ファイル、テスト、TODO、Gitの状態を実際に確認し、推測で依存関係や未実装部分を追加しないでください。',
    '',
    '分析結果を、human-stack-battle-20260715の概念図を見本にした、見やすい左から右へ流れる architecture-graph JSON として出力してください。',
    '',
    '必須条件:',
    '- JSONの前後に説明を書かず、JSONだけを返す',
    '- schema_version は 1、kind は architecture-graph',
    `- project.project_id は "${project.projectId}"`,
    '- groups、components、edges、flows、presentation を必ず含める',
    '- componentsのgroup、edgesのsource/target、flowsのnode_ids/edge_idsは必ず実在するIDを参照する',
    '- IDは英数字とハイフンを中心に一意にする',
    '- components.files には実在するファイルだけを記載する',
    '- コンポーネントは論理単位でまとめ、全ファイルを1ノードにしない',
    '- presentation.layout は left-to-right',
    '- presentation.group_order は actors, client, services, data, operations の順',
    '- presentation.primary_flow は主要フローID（なければ空文字）',
    '- URLはhttp/httpsまたは空文字にする',
    '',
    '出力するJSONのトップレベル構造:',
    '{',
    '  "schema_version": 1,',
    '  "kind": "architecture-graph",',
    '  "document": {},',
    `  "project": { "project_id": ${projectId}, "name": ${projectName} },`,
    '  "groups": [],',
    '  "components": [],',
    '  "edges": [],',
    '  "flows": [],',
    '  "presentation": {},',
    '  "extensions": {}',
    '}',
    '',
    '既存の architecture-graph スキーマに完全準拠し、実際のコードに基づく内容だけを出力してください。'
  ].join('\n');
}

function renderArchitecturePageContent(project, meta, documentData = null) {
  const presentation = architectureStatusPresentation(meta.status);
  const counts = documentData ? {
    components: documentData.components.length,
    edges: documentData.edges.length,
    flows: documentData.flows.length
  } : meta.counts;
  const notice = meta.status === 'stale'
    ? '<div class="architecture-notice stale" role="status"><strong>更新があります。</strong> 保存済みの図は閲覧できますが、現在のコードに合わせて再解析してください。</div>'
    : meta.status === 'error'
      ? `<div class="architecture-notice error" role="alert"><strong>概念図の処理でエラーが発生しました。</strong>${meta.lastError ? ` ${escapeHtml(meta.lastError)}` : ''}</div>`
      : '';
  elements.architectureContent.innerHTML = `
    <div class="architecture-page-header">
      <div>
        <div class="architecture-card-heading">
          <h2 id="architecture-title" tabindex="-1">${escapeHtml(project.name)}の概念図</h2>
          <span class="architecture-state ${escapeHtml(meta.status)}">${escapeHtml(presentation.label)}</span>
        </div>
        <p>${escapeHtml(project.projectId)}${meta.analyzedAt ? ` / 解析 ${escapeHtml(formatDate(meta.analyzedAt))}` : ''}${documentData ? ` / ${counts.components}コンポーネント・${counts.edges}接続・${counts.flows}フロー` : ''}</p>
      </div>
      <div class="architecture-page-actions" aria-label="概念図のデータ操作">
        <button type="button" class="primary" data-architecture-action="copy-prompt">Codexで作成・更新</button>
        <button type="button" data-architecture-action="import">JSONを読み込む</button>
        <details class="action-menu">
          <summary>その他の操作</summary>
          <div class="action-menu-panel">
            <button type="button" data-architecture-action="copy-json-prompt">AI用JSONプロンプトをコピー</button>
            ${documentData ? '<button type="button" data-architecture-action="export">JSONを書き出す</button>' : ''}
            <button type="button" data-architecture-action="refresh">再読み込み</button>
          </div>
        </details>
      </div>
    </div>
    <p class="architecture-codex-note">Codexで作成・更新する場合は、関連付け済みの対象プロジェクトをCodexで開き、コピーしたキーフレーズだけを貼り付けてください。</p>
    ${notice}
    ${documentData
      ? '<div id="architecture-viewer-root"></div>'
      : `<div class="architecture-empty"><h3>${meta.status === 'error' ? '概念図を表示できません' : '概念図はまだありません'}</h3><p>${escapeHtml(presentation.description)} 上の「Codexで作成・更新」を使うか、作成済みJSONを読み込んでください。</p></div>`}`;
  elements.architectureUpdated.textContent = meta.analyzedAt ? `概念図更新 ${formatDate(meta.analyzedAt)}` : '';
  if (documentData) {
    const root = document.querySelector('#architecture-viewer-root');
    state.architectureViewer = window.ArchitectureViewer.mount(root, { data: documentData, onNotify: showMessage });
  }
}

async function renderArchitecturePage(project) {
  const sequence = ++state.architectureLoadSequence;
  destroyArchitectureViewer();
  elements.architectureContent.innerHTML = '<div class="architecture-loading" role="status">概念図を読み込んでいます…</div>';
  elements.architectureUpdated.textContent = '';
  let meta = await loadArchitectureMeta(project, { force: true });
  let documentData = null;
  if (meta.hasValidDocument || ['ready', 'stale'].includes(meta.status)) {
    try {
      let response;
      if (project._local) {
        try { response = await api(architectureBasePath(project.projectId)); }
        catch (error) {
          if (error.status !== 404 || !project._teamVersion?.architecture) throw error;
          response = project._teamVersion.architecture;
        }
      } else response = project._teamVersion?.architecture || project.architecture;
      documentData = response?.architecture || response?.data || response;
      const errors = window.ArchitectureViewer?.validate(documentData) || ['概念図Viewerを読み込めませんでした。'];
      if (errors.length) throw new Error(errors.join('\n'));
      if (documentData.project.project_id !== project.projectId) throw new Error(`概念図のproject_idが「${project.projectId}」と一致しません。`);
      meta = {
        ...meta,
        hasValidDocument: true,
        counts: { components: documentData.components.length, edges: documentData.edges.length, flows: documentData.flows.length }
      };
      state.architectureMetaByProject.set(project.projectId, meta);
    } catch (error) {
      documentData = null;
      meta = { ...meta, status: 'error', hasValidDocument: false, lastError: error.message };
    }
  }
  if (sequence !== state.architectureLoadSequence || currentRoute().name !== 'architecture' || currentDetailId() !== project.projectId) return;
  state.architectureDocument = documentData;
  try {
    renderArchitecturePageContent(project, meta, documentData);
  } catch (error) {
    destroyArchitectureViewer();
    meta = { ...meta, status: 'error', hasValidDocument: false, lastError: error.message };
    renderArchitecturePageContent(project, meta, null);
  }
  requestAnimationFrame(() => document.querySelector('#architecture-title')?.focus?.());
}

function renderRoute() {
  const route = currentRoute();
  if (route.name === 'unknown') {
    showMessage('指定された画面が見つかりません。', true);
    location.hash = '';
    return;
  }
  if (route.name === 'list') {
    destroyArchitectureViewer();
    state.architectureLoadSequence += 1;
    elements.listView.hidden = false;
    elements.detailView.hidden = true;
    elements.architectureView.hidden = true;
    document.title = '開発プロジェクト台帳';
    return;
  }
  const project = state.projects.find((item) => item.projectId === route.projectId);
  if (!project) {
    showMessage('指定されたプロジェクトが見つかりません。', true);
    location.hash = '';
    return;
  }
  elements.listView.hidden = true;
  if (route.name === 'architecture') {
    elements.detailView.hidden = true;
    elements.architectureView.hidden = false;
    document.title = `${project.name}の概念図 | 開発プロジェクト台帳`;
    window.scrollTo(0, 0);
    void renderArchitecturePage(project);
    return;
  }
  destroyArchitectureViewer();
  state.architectureLoadSequence += 1;
  elements.detailView.hidden = false;
  elements.architectureView.hidden = true;
  renderDetail(project);
  document.title = `${project.name} | 開発プロジェクト台帳`;
  window.scrollTo(0, 0);
}

function architectureRequestId() {
  return globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openArchitectureImport(project) {
  state.architectureImportData = null;
  state.architectureImportPreview = null;
  elements.architectureImportFile.value = '';
  elements.architectureImportText.value = '';
  elements.architectureImportPreview.hidden = true;
  elements.architectureImportPreview.innerHTML = '';
  elements.architectureImportCommit.hidden = true;
  clearInlineError(elements.architectureImportError);
  elements.architectureImportDialog.dataset.projectId = project.projectId;
  elements.architectureImportDialog.showModal();
  requestAnimationFrame(() => elements.architectureImportFile.focus());
}

async function createArchitectureTemplate() {
  const projectId = elements.architectureImportDialog.dataset.projectId;
  clearInlineError(elements.architectureImportError);
  try {
    const response = await api(`${architectureBasePath(projectId)}/template`);
    elements.architectureImportText.value = JSON.stringify(response.architecture || response, null, 2);
    elements.architectureImportText.focus();
  } catch (error) {
    showInlineError(elements.architectureImportError, error);
  }
}

async function previewArchitectureImport() {
  const projectId = elements.architectureImportDialog.dataset.projectId;
  const project = state.projects.find((item) => item.projectId === projectId);
  const selectedFile = elements.architectureImportFile.files[0];
  const file = selectedFile || (elements.architectureImportText.value.trim()
    ? { size: new Blob([elements.architectureImportText.value]).size, text: async () => elements.architectureImportText.value }
    : null);
  clearInlineError(elements.architectureImportError);
  elements.architectureImportPreview.hidden = true;
  elements.architectureImportCommit.hidden = true;
  if (!project) return showInlineError(elements.architectureImportError, new Error('対象プロジェクトが見つかりません。'));
  if (!file) return showInlineError(elements.architectureImportError, new Error('JSONファイルを選択してください。'));
  const button = document.querySelector('#architecture-import-preview-button');
  button.disabled = true;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('JSONファイルは2MB以下にしてください。');
    const data = JSON.parse(await file.text());
    const errors = window.ArchitectureViewer?.validate(data) || ['概念図Viewerを読み込めませんでした。'];
    if (errors.length) throw new Error(errors.join('\n'));
    if (data.project.project_id !== project.projectId) throw new Error(`project.project_idは「${project.projectId}」にしてください。`);
    const requestId = architectureRequestId();
    const expectedRevision = state.architectureMetaByProject.get(project.projectId)?.revision || '';
    const preview = await api(`${architectureBasePath(project.projectId)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ data, source: 'web', requestId, expectedRevision })
    });
    state.architectureImportData = data;
    state.architectureImportPreview = { response: preview, requestId, expectedRevision: preview.currentRevision ?? expectedRevision };
    const counts = preview.counts || { components: data.components.length, edges: data.edges.length, flows: data.flows.length };
    elements.architectureImportPreview.innerHTML = `<p class="architecture-import-summary"><strong>保存前の確認</strong><br>${escapeHtml(preview.message || 'JSONの構造と参照関係を検証しました。')}</p><div class="architecture-preview-counts"><span>コンポーネント: ${Number(counts.components ?? counts.nodes ?? data.components.length)}</span><span>接続: ${Number(counts.edges ?? data.edges.length)}</span><span>フロー: ${Number(counts.flows ?? data.flows.length)}</span></div>`;
    elements.architectureImportPreview.hidden = false;
    elements.architectureImportCommit.hidden = false;
  } catch (error) {
    showInlineError(elements.architectureImportError, error instanceof SyntaxError ? new Error('JSONファイルの構文が正しくありません。') : error);
  } finally {
    button.disabled = false;
  }
}

async function commitArchitectureImport() {
  const projectId = elements.architectureImportDialog.dataset.projectId;
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project || !state.architectureImportData || !state.architectureImportPreview) return;
  clearInlineError(elements.architectureImportError);
  elements.architectureImportCommit.disabled = true;
  try {
    const { requestId, expectedRevision } = state.architectureImportPreview;
    await api(`${architectureBasePath(project.projectId)}/commit`, {
      method: 'POST',
      body: JSON.stringify({ data: state.architectureImportData, source: 'web', requestId, expectedRevision })
    });
    elements.architectureImportDialog.close();
    state.architectureMetaByProject.delete(project.projectId);
    showMessage('概念図JSONを台帳へ保存しました。');
    if (currentRoute().name === 'architecture' && currentDetailId() === project.projectId) await renderArchitecturePage(project);
  } catch (error) {
    showInlineError(elements.architectureImportError, error);
  } finally {
    elements.architectureImportCommit.disabled = false;
  }
}

function exportArchitecture(project) {
  const link = document.createElement('a');
  link.href = `${architectureBasePath(project.projectId)}/export`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
  showMessage('概念図JSONを書き出します。');
}

function openManual(project = null) {
  state.editingProjectId = project?.projectId || null;
  elements.manualForm.reset();
  clearInlineError(elements.manualError);
  const form = elements.manualForm.elements;
  form.status.innerHTML = statusOptions(project?.status || 'idea');
  elements.manualTitle.textContent = project ? 'プロジェクトを手動編集' : '新規プロジェクト登録';
  form.projectId.disabled = Boolean(project);
  if (project) {
    form.name.value = project.name;
    form.projectId.value = project.projectId;
    form.owner.value = project.owner;
    form.appUrl.value = project.appUrl;
    form.adminUrl.value = project.adminUrl || '';
    form.repositoryUrl.value = project.repositoryUrl;
    form.developmentUrl.value = project.developmentUrl;
    form.status.value = project.status;
    form.progress.value = project.progress;
    form.tags.value = project.tags.join(', ');
    form.summary.value = project.summary;
    form.currentTasks.value = listText(project.currentTasks);
    form.nextTasks.value = listText(project.nextTasks);
    form.blockers.value = listText(project.blockers);
  } else {
    form.progress.value = 0;
  }
  elements.manualDialog.showModal();
  requestAnimationFrame(() => form.name.focus());
}

function manualPayload() {
  const form = elements.manualForm.elements;
  return {
    projectId: form.projectId.value.trim(),
    name: form.name.value.trim(),
    appUrl: form.appUrl.value.trim(),
    adminUrl: form.adminUrl.value.trim(),
    repositoryUrl: form.repositoryUrl.value.trim(),
    developmentUrl: form.developmentUrl.value.trim(),
    status: form.status.value,
    progress: Number(form.progress.value),
    owner: form.owner.value.trim(),
    tags: splitTags(form.tags.value),
    summary: form.summary.value.trim(),
    currentTasks: splitLines(form.currentTasks.value),
    nextTasks: splitLines(form.nextTasks.value),
    blockers: splitLines(form.blockers.value)
  };
}

async function saveManual() {
  clearInlineError(elements.manualError);
  if (!elements.manualForm.reportValidity()) return;
  const button = document.querySelector('#manual-save');
  button.disabled = true;
  try {
    const payload = manualPayload();
    const editing = state.editingProjectId;
    const existing = editing ? state.projects.find(project => project.projectId === editing) : null;
    let project;
    if (existing?._team) {
      project = await saveSharedProject(existing, payload);
    } else {
      project = await api(editing ? `/api/projects/${encodeURIComponent(editing)}` : '/api/projects', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
    }
    elements.manualDialog.close();
    await loadProjects();
    showMessage(editing ? 'プロジェクトを更新しました。' : 'プロジェクトを登録しました。');
    if (editing) location.hash = `#/project/${encodeURIComponent(project.projectId)}`;
  } catch (error) {
    showInlineError(elements.manualError, error);
  } finally {
    button.disabled = false;
  }
}

function openAiImport(expectedMode = '', projectId = '') {
  state.aiExpectedMode = expectedMode;
  state.aiExpectedProjectId = projectId;
  state.aiPreview = null;
  state.aiText = '';
  elements.aiTextArea.value = '';
  elements.aiPreviewBox.hidden = true;
  elements.aiPreviewBox.innerHTML = '';
  elements.aiCommit.hidden = true;
  clearInlineError(elements.aiError);
  if (expectedMode === 'update') {
    elements.aiTitle.textContent = 'AI出力でプロジェクトを更新';
    elements.aiGuidance.textContent = `modeがupdate、project_idが「${projectId}」のJSONを貼り付けてください。解析後に変更内容を比較します。`;
  } else {
    elements.aiTitle.textContent = 'AI出力を取り込む';
    elements.aiGuidance.textContent = 'project-statusコードブロック、jsonコードブロック、または生JSONを貼り付けてください。解析後に内容を確認します。';
  }
  elements.aiDialog.showModal();
  requestAnimationFrame(() => elements.aiTextArea.focus());
}

function renderAiPreview(preview) {
  const project = preview.project;
  if (preview.mode === 'create') {
    elements.aiPreviewBox.innerHTML = `
      <h3 class="preview-heading">登録内容の確認</h3>
      <table class="compare-table"><tbody>
        <tr><th>プロジェクト名</th><td>${escapeHtml(project.name)}</td></tr>
        <tr><th>プロジェクトID</th><td>${escapeHtml(project.projectId)}</td></tr>
        <tr><th>アプリURL</th><td>${escapeHtml(project.appUrl || '—')}</td></tr>
        <tr><th>管理者サイトURL</th><td>${escapeHtml(project.adminUrl || '—')}</td></tr>
        <tr><th>状態</th><td>${escapeHtml(STATUS_LABELS[project.status])}</td></tr>
        <tr><th>進捗</th><td>${project.progress}%</td></tr>
        <tr><th>担当者</th><td>${escapeHtml(project.owner || '—')}</td></tr>
        <tr><th>概要</th><td>${escapeHtml(project.summary || '—')}</td></tr>
        <tr><th>現在のタスク</th><td>${escapeHtml(formatCompareValue(project.currentTasks))}</td></tr>
        <tr><th>次のタスク</th><td>${escapeHtml(formatCompareValue(project.nextTasks))}</td></tr>
        <tr><th>ブロッカー</th><td>${escapeHtml(formatCompareValue(project.blockers))}</td></tr>
      </tbody></table>`;
    elements.aiCommit.textContent = '登録を確定';
  } else {
    elements.aiPreviewBox.innerHTML = `
      <h3 class="preview-heading">変更内容の比較</h3>
      <table class="compare-table">
        <thead><tr><th>項目</th><th>更新前</th><th>更新後</th></tr></thead>
        <tbody>${preview.changes.map((change) => `<tr class="${change.changed ? 'changed' : ''}"><th>${escapeHtml(change.label)}</th><td>${escapeHtml(formatCompareValue(change.before, change.key))}</td><td>${escapeHtml(formatCompareValue(change.after, change.key))}</td></tr>`).join('')}</tbody>
      </table>`;
    elements.aiCommit.textContent = '更新を確定';
  }
  elements.aiPreviewBox.hidden = false;
  elements.aiCommit.hidden = false;
}

async function analyzeAi() {
  clearInlineError(elements.aiError);
  elements.aiPreviewBox.hidden = true;
  elements.aiCommit.hidden = true;
  const text = elements.aiTextArea.value;
  try {
    const preview = await api('/api/import/preview', {
      method: 'POST',
      body: JSON.stringify({ text, expectedMode: state.aiExpectedMode || undefined })
    });
    if (state.aiExpectedProjectId && preview.project.projectId !== state.aiExpectedProjectId) {
      throw new Error(`project_idが一致しません。${state.aiExpectedProjectId}を指定してください。`);
    }
    state.aiText = text;
    state.aiPreview = preview;
    renderAiPreview(preview);
  } catch (error) {
    showInlineError(elements.aiError, error);
  }
}

async function commitAi() {
  if (!state.aiPreview) return;
  elements.aiCommit.disabled = true;
  try {
    const project = await api('/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ text: state.aiText, source: 'web-ai' })
    });
    elements.aiDialog.close();
    await loadProjects();
    const merged = state.projects.find(item => item.projectId === project.projectId);
    if (state.aiPreview.mode === 'update' && merged?._team && merged._local && merged._syncState === 'local-ahead') {
      await syncLocalToTeam(merged, { confirm: false, silent: true });
    }
    showMessage(state.aiPreview.mode === 'create' ? 'AI出力から登録しました。' : 'AI出力で更新しました。');
    if (state.aiPreview.mode === 'update') location.hash = `#/project/${encodeURIComponent(project.projectId)}`;
  } catch (error) {
    showInlineError(elements.aiError, error);
  } finally {
    elements.aiCommit.disabled = false;
  }
}

async function openCliDialog() {
  clearInlineError(elements.cliError);
  const baseUrl = location.origin;
  const basicCommand = `.\\project-manager.cmd doctor\n.\\project-manager.cmd list\n.\\project-manager.cmd show <project-id>`;
  const jsonCommand = `.\\project-manager.cmd preview --file status.json\nGet-Content status.json | .\\project-manager.cmd apply --stdin`;
  const linkCommand = `.\\project-manager.cmd link <project-id> --url ${baseUrl}`;
  elements.cliUrl.textContent = baseUrl;
  elements.cliBasicCommand.textContent = basicCommand;
  elements.cliJsonCommand.textContent = jsonCommand;
  elements.cliLinkCommand.textContent = linkCommand;
  elements.cliService.textContent = '確認中…';
  elements.cliVersion.textContent = '—';
  elements.cliDialog.showModal();
  try {
    const meta = await api('/api/meta');
    elements.cliService.textContent = meta.service;
    elements.cliVersion.textContent = meta.version;
  } catch (error) {
    elements.cliService.textContent = '接続エラー';
    showInlineError(elements.cliError, error);
  }
}

const CREATE_PROMPT = `この開発プロジェクト全体を確認し、現在の開発状況を分析してください。

README、ソースコード、設定ファイル、TODO、コミット可能な変更、未実装部分を確認し、プロジェクト管理システムへ登録するための情報を出力してください。

推測だけで進捗を決めず、実際のコードとファイルの状態から判断してください。
進捗率は0から100の整数にしてください。

必ず指定されたJSON形式で出力してください。
JSONの前後に説明を書かず、コードブロックだけを返してください。

\`\`\`project-status
{
  "schema_version": 1,
  "mode": "create",
  "project_id": "英数字とハイフンで構成した一意のID",
  "name": "プロジェクト名",
  "app_url": "",
  "admin_url": "",
  "repository_url": "",
  "development_url": "",
  "status": "idea | planning | development | testing | release_ready | published | update_pending | blocked | paused | archived",
  "progress": 0,
  "owner": "",
  "tags": [],
  "summary": "現在の開発状況を簡潔に記載",
  "current_tasks": [],
  "next_tasks": [],
  "blockers": [],
  "updated_at": "ISO 8601形式"
}
\`\`\``;

function updatePrompt(project) {
  const current = {
    schema_version: 1,
    mode: 'update',
    project_id: project.projectId,
    name: project.name,
    app_url: project.appUrl,
    admin_url: project.adminUrl || '',
    repository_url: project.repositoryUrl,
    development_url: project.developmentUrl,
    status: project.status,
    progress: project.progress,
    owner: project.owner,
    tags: project.tags,
    summary: project.summary,
    current_tasks: project.currentTasks,
    next_tasks: project.nextTasks,
    blockers: project.blockers,
    updated_at: project.updatedAt
  };
  return `この開発プロジェクト全体を確認し、前回登録時点から現在までの変化を分析してください。

README、ソースコード、設定ファイル、TODO、テスト結果、未実装部分を確認してください。

以下は前回登録されていた情報です。

${JSON.stringify(current, null, 2)}

実際のコードと現在の動作状態を基準に、状態、進捗、作業内容、次のタスク、ブロッカーを更新してください。
進捗率は0から100の整数にしてください。前回の数値をそのまま流用せず、現在の状態から再評価してください。

必ず指定されたJSON形式で出力してください。JSONの前後に説明を書かず、project-statusコードブロックだけを返してください。
project_idは「${project.projectId}」から変更せず、modeは「update」にしてください。`;
}

async function copyText(text, successMessage = 'コピーしました。') {
  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard APIを利用できません。');
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    try {
      const temporary = document.createElement('textarea');
      temporary.value = text;
      temporary.style.position = 'fixed';
      temporary.style.opacity = '0';
      document.body.append(temporary);
      temporary.select();
      copied = document.execCommand('copy');
      temporary.remove();
    } catch {
      copied = false;
    }
  }
  showMessage(copied ? successMessage : 'コピーできませんでした。IDを選択してコピーしてください。', !copied);
  return copied;
}

function confirmAction(message, confirmLabel = '実行する') {
  if (state.confirmResolve) state.confirmResolve(false);
  elements.confirmMessage.textContent = message;
  document.querySelector('#confirm-ok').textContent = confirmLabel;
  elements.confirmDialog.showModal();
  return new Promise((resolve) => { state.confirmResolve = resolve; });
}

function resolveConfirm(result) {
  if (!state.confirmResolve) return;
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  elements.confirmDialog.close();
  resolve(result);
}

async function deleteProject(project) {
  const confirmed = await confirmAction(`「${project.name}」を削除します。元に戻せません。`, '削除する');
  if (!confirmed) return;
  try {
    await api(`/api/projects/${encodeURIComponent(project.projectId)}`, { method: 'DELETE' });
    location.hash = '';
    await loadProjects();
    showMessage('プロジェクトを削除しました。');
  } catch (error) {
    showMessage(error.message, true);
  }
}

function openBackup() {
  state.backupData = null;
  state.backupPreview = null;
  elements.backupFile.value = '';
  elements.backupPreviewBox.hidden = true;
  elements.backupCommit.hidden = true;
  clearInlineError(elements.backupError);
  elements.backupDialog.showModal();
}

async function previewBackup() {
  clearInlineError(elements.backupError);
  elements.backupPreviewBox.hidden = true;
  elements.backupCommit.hidden = true;
  const file = elements.backupFile.files[0];
  if (!file) return showInlineError(elements.backupError, new Error('JSONファイルを選択してください。'));
  try {
    const data = JSON.parse(await file.text());
    const preview = await api('/api/backup/preview', { method: 'POST', body: JSON.stringify({ data }) });
    state.backupData = data;
    state.backupPreview = preview;
    elements.backupPreviewBox.innerHTML = `<strong>取り込み前の確認</strong><br>現在: ${preview.currentCount}件 / ファイル: ${preview.projectCount}件 / 新規: ${preview.newCount}件 / 同じID: ${preview.updateCount}件${preview.conflicts.length ? `<br>同じID: ${escapeHtml(preview.conflicts.join(', '))}` : ''}`;
    elements.backupPreviewBox.hidden = false;
    elements.backupCommit.hidden = false;
  } catch (error) {
    if (error instanceof SyntaxError) showInlineError(elements.backupError, new Error('JSONファイルの構文が正しくありません。'));
    else showInlineError(elements.backupError, error);
  }
}

async function commitBackup() {
  if (!state.backupData || !state.backupPreview) return;
  const strategy = document.querySelector('input[name="backup-strategy"]:checked').value;
  const message = strategy === 'replace'
    ? `現在の全データを、ファイル内の${state.backupPreview.projectCount}件で置き換えます。`
    : `ファイル内の${state.backupPreview.projectCount}件を追加・更新します。`;
  const confirmed = await confirmAction(message, '取り込む');
  if (!confirmed) return;
  elements.backupCommit.disabled = true;
  try {
    await api('/api/backup/commit', {
      method: 'POST',
      body: JSON.stringify({ data: state.backupData, strategy })
    });
    elements.backupDialog.close();
    location.hash = '';
    await loadProjects();
    showMessage('バックアップを取り込みました。');
  } catch (error) {
    showInlineError(elements.backupError, error);
  } finally {
    elements.backupCommit.disabled = false;
  }
}

function teamConfig() {
  try { return JSON.parse(localStorage.getItem('pm-team') || '{}'); } catch { return {}; }
}
function teamProjectPayload(project) {
  const fields = ['projectId','name','appUrl','adminUrl','repositoryUrl','developmentUrl','status','progress','owner','tags','summary','currentTasks','nextTasks','blockers'];
  return Object.fromEntries(fields.map((key) => [key, project[key]]));
}
function teamRevision(project) {
  return project?._teamVersion?.revision || (!project?._local ? project?.revision : '');
}

async function putTeamProject(project, draft) {
  const config = teamConfig();
  const base = project._teamVersion || project;
  try {
    return await teamApi(config, `/api/projects/${encodeURIComponent(project.projectId)}`, {
      method: 'PUT', body: JSON.stringify({ project: teamProjectPayload(draft), expectedRevision: teamRevision(project) })
    });
  } catch (error) {
    if (!error.latest) throw error;
    const resolution = TeamSync.threeWayMerge(base, draft, error.latest);
    if (resolution.conflicts.length) {
      const names = resolution.conflicts.map(item => item.field).join('、');
      throw Object.assign(new Error(`同じ項目が別のメンバーにも更新されています（${names}）。最新内容を取り込んでから再編集してください。`), { latest: error.latest, conflicts: resolution.conflicts });
    }
    return teamApi(config, `/api/projects/${encodeURIComponent(project.projectId)}`, {
      method: 'PUT', body: JSON.stringify({ project: teamProjectPayload(resolution.merged), expectedRevision: error.latest.revision })
    });
  }
}

async function saveSharedProject(project, draft) {
  let local = project._localVersion;
  if (project._local) {
    local = await api(`/api/projects/${encodeURIComponent(project.projectId)}`, { method: 'PUT', body: JSON.stringify(draft) });
  }
  const result = await putTeamProject(project, draft);
  saveTeamSyncMeta(teamConfig(), local || draft, result.project);
  return result.project;
}
async function teamApi(config, path, options = {}) {
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('チームURLはHTTPSで指定してください。');
  const response = await fetch(`${url.origin}${path}`, { ...options, credentials: 'omit', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'チームとの通信に失敗しました。'), data, { status: response.status });
  return data;
}
function openTeamSettings() {
  const config = teamConfig();
  document.querySelector('#team-url').value = config.url || '';
  document.querySelector('#team-token').value = config.token || '';
  document.querySelector('#team-error').hidden = true;
  document.querySelector('#team-dialog').showModal();
}
async function shareTeamProject(project) {
  const config = teamConfig();
  if (!config.url || !config.token) return openTeamSettings();
  let payload;
  try {
    payload = teamProjectPayload(project);
    if (!await confirmAction(`「${project.name}」の進捗・URL・タスクをチーム全員に共有します。ローカルの履歴やプロジェクトフォルダ設定は送信しません。`, '共有する')) return;
    const meta = await api(`${architectureBasePath(project.projectId)}/meta`);
    if (normalizeArchitectureMeta(meta).hasValidDocument && await confirmAction('保存済みの概念図も共有しますか？図に含まれるソースパスや説明もチームに公開されます。', '概念図も共有')) {
      const graph = await api(architectureBasePath(project.projectId));
      payload.architecture = graph.architecture || graph.data || graph;
    }
    const key = teamRevisionKey(config, project.projectId);
    const result = await teamApi(config, '/api/projects/share', { method: 'POST', body: JSON.stringify({ project: payload, expectedRevision: localStorage.getItem(key) || '' }) });
    saveTeamSyncMeta(config, project._localVersion || project, result.project);
    await loadProjects();
    showMessage('チームへ共有し、一覧へ統合しました。');
  } catch (error) {
    if (error.latest) {
      const differences = Object.keys(payload).filter(key => JSON.stringify(payload[key]) !== JSON.stringify(error.latest[key])).map(key => `${key}\n共有先: ${JSON.stringify(error.latest[key])}\nこのPC: ${JSON.stringify(payload[key])}`).join('\n\n');
      if (!await confirmAction(`共有先に @${error.latest.updatedBy || 'メンバー'} の更新があります。以下の差分を確認してください。\n\n${differences}\n\nこのPCの内容で共有先を更新しますか？キャンセルすると共有先を維持します。`, '差分を確認して更新')) return;
      try {
        const result = await teamApi(config, '/api/projects/share', { method: 'POST', body: JSON.stringify({ project: payload, expectedRevision: error.latest.revision }) });
        saveTeamSyncMeta(config, project._localVersion || project, result.project);
        showMessage('確認した内容でチームを更新しました。');
      } catch (retryError) { showMessage(retryError.message, true); }
    } else showMessage(error.message, true);
  }
}

function teamDifferenceText(project) {
  const labels = { name:'名前', appUrl:'アプリURL', adminUrl:'管理者URL', repositoryUrl:'リポジトリURL', developmentUrl:'開発URL', status:'状態', progress:'進捗', owner:'担当者', tags:'タグ', summary:'概要', currentTasks:'現在の作業', nextTasks:'次の作業', blockers:'課題' };
  return TeamSync.differences(project._localVersion, project._teamVersion).map(item => `${labels[item.field] || item.field}\nローカル: ${formatCompareValue(item.local, item.field)}\nチーム: ${formatCompareValue(item.team, item.field)}`).join('\n\n') || '内容は一致しています。';
}

async function syncLocalToTeam(project, { confirm = true, silent = false } = {}) {
  const config = teamConfig();
  const local = project._localVersion || project;
  const team = project._teamVersion;
  if (!local || !team) return;
  if (confirm && !await confirmAction(`以下のローカル更新をチームへ反映します。\n\n${teamDifferenceText(project)}`, 'チームへ反映')) return;
  try {
    const result = await putTeamProject(project, local);
    saveTeamSyncMeta(config, local, result.project);
    await loadProjects();
    if (!silent) showMessage('ローカルの更新をチームへ反映しました。');
    return result.project;
  } catch (error) {
    await loadProjects();
    if (!silent) showMessage(error.message, true);
    throw error;
  }
}

async function syncTeamToLocal(project) {
  const config = teamConfig(); const team = project._teamVersion;
  if (!project._localVersion || !team) return;
  if (!await confirmAction(`チーム版をこのPCへ取り込みます。ローカルの対象項目は置き換わります。\n\n${teamDifferenceText(project)}`, 'チーム版を取り込む')) return;
  try {
    const local = await api(`/api/projects/${encodeURIComponent(project.projectId)}`, { method:'PUT', body:JSON.stringify(teamProjectPayload(team)) });
    saveTeamSyncMeta(config, local, team);
    await loadProjects(); showMessage('チーム更新をローカルへ取り込みました。');
  } catch (error) { showMessage(error.message, true); }
}

async function unshareTeamProject(project) {
  if (!project._team) return;
  const config = teamConfig();
  if (!config.url || !config.token) return openTeamSettings();
  const localNote = project._local
    ? 'このPCのローカルプロジェクトと概念図は残ります。'
    : 'このPCにローカル版がないため、解除後は一覧から消えます。';
  if (!await confirmAction(`「${project.name}」をチーム共有から解除します。共有一覧からは消えますが、管理者が復元できる状態でチーム側に保管されます。${localNote}`, '共有を解除')) return;
  try {
    await teamApi(config, `/api/projects/${encodeURIComponent(project.projectId)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision: teamRevision(project) })
    });
    localStorage.removeItem(teamRevisionKey(config, project.projectId));
    await loadProjects();
    const remaining = state.projects.find(item => item.projectId === project.projectId);
    location.hash = remaining ? `#/project/${encodeURIComponent(project.projectId)}` : '';
    showMessage('チーム共有を解除しました。ローカルデータは変更していません。');
  } catch (error) {
    if (error.latest) await loadProjects();
    showMessage(error.message, true);
  }
}
document.querySelector('#team-settings-button').addEventListener('click', openTeamSettings);
document.querySelector('#team-save').addEventListener('click', async () => {
  const config = { url: document.querySelector('#team-url').value.trim(), token: document.querySelector('#team-token').value.trim() };
  try {
    const data = await teamApi(config, '/api/projects');
    config.url = new URL(config.url).origin;
    config.team = data.team;
    localStorage.setItem('pm-team', JSON.stringify(config));
    document.querySelector('#team-dialog').close();
    await loadProjects();
    showMessage('チーム接続を保存し、共有データを一覧へ統合しました。');
  } catch (error) { showInlineError(document.querySelector('#team-error'), error); }
});
document.querySelector('#team-disconnect').addEventListener('click', () => {
  localStorage.removeItem('pm-team');
  document.querySelector('#team-token').value = '';
  state.teamProjects = [];
  mergeProjects();
  updateOwnerFilter();
  renderList();
  document.querySelector('#team-sync-button').hidden = true;
  showMessage('このブラウザのチーム接続を解除しました。');
});
document.querySelector('#team-sync-button').addEventListener('click', syncTeamProjects);
document.querySelector('#new-project-button').addEventListener('click', () => openManual());
document.querySelector('#ai-import-button').addEventListener('click', () => openAiImport());
document.querySelector('#cli-button').addEventListener('click', openCliDialog);
document.querySelector('#manual-save').addEventListener('click', saveManual);
document.querySelector('#ai-analyze').addEventListener('click', analyzeAi);
elements.aiCommit.addEventListener('click', commitAi);
document.querySelector('#copy-create-prompt').addEventListener('click', () => copyText(CREATE_PROMPT));
document.querySelector('#copy-cli-basic').addEventListener('click', () => copyText(elements.cliBasicCommand.textContent));
document.querySelector('#copy-cli-json').addEventListener('click', () => copyText(elements.cliJsonCommand.textContent));
document.querySelector('#copy-cli-link').addEventListener('click', () => copyText(elements.cliLinkCommand.textContent));
document.querySelector('#backup-button').addEventListener('click', openBackup);
document.querySelector('#backup-preview-button').addEventListener('click', previewBackup);
elements.backupCommit.addEventListener('click', commitBackup);
document.querySelector('#architecture-import-preview-button').addEventListener('click', previewArchitectureImport);
elements.architectureImportCommit.addEventListener('click', commitArchitectureImport);
elements.architectureTemplateButton.addEventListener('click', createArchitectureTemplate);
elements.architectureImportFile.addEventListener('change', () => {
  const file = elements.architectureImportFile.files[0];
  if (file) file.text().then((text) => { elements.architectureImportText.value = text; }).catch(() => {});
  state.architectureImportData = null;
  state.architectureImportPreview = null;
  elements.architectureImportPreview.hidden = true;
  elements.architectureImportCommit.hidden = true;
  clearInlineError(elements.architectureImportError);
});
document.querySelector('#export-button').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = '/api/export';
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
  showMessage('バックアップJSONを書き出します。');
});
document.querySelector('#back-button').addEventListener('click', () => { location.hash = ''; });
document.querySelector('#architecture-back-button').addEventListener('click', () => {
  const projectId = currentDetailId();
  location.hash = projectId ? `#/project/${encodeURIComponent(projectId)}` : '';
});

elements.manualForm.addEventListener('submit', (event) => event.preventDefault());

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});

elements.rows.addEventListener('click', async (event) => {
  const statusSelect = event.target.closest('[data-status-id]');
  if (statusSelect) return;
  if (event.target.closest('a, button, input, select, textarea')) return;
  const row = event.target.closest('[data-project-id]');
  if (row) location.hash = `#/project/${encodeURIComponent(row.dataset.projectId)}`;
});

elements.rows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.target.matches('select, a, button, input')) return;
  const row = event.target.closest('[data-project-id]');
  if (row) location.hash = `#/project/${encodeURIComponent(row.dataset.projectId)}`;
});

elements.rows.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-status-id]');
  if (!select) return;
  const previous = state.projects.find((item) => item.projectId === select.dataset.statusId);
  if (!previous) return;
  select.disabled = true;
  try {
    if (previous._team) {
      const payload = { ...teamProjectPayload(previous), status: select.value };
      await saveSharedProject(previous, payload);
    } else {
      await api(`/api/projects/${encodeURIComponent(previous.projectId)}`, {
        method: 'PUT', body: JSON.stringify({ status: select.value })
      });
    }
    await loadProjects();
    showMessage('管理状態を更新しました。');
  } catch (error) {
    select.value = previous.status;
    showMessage(error.message, true);
  } finally {
    select.disabled = false;
  }
});

elements.detailContent.addEventListener('click', (event) => {
  const action = event.target.closest('[data-detail-action]')?.dataset.detailAction;
  if (!action) return;
  const project = state.projects.find((item) => item.projectId === currentDetailId());
  if (!project) return;
  if (action === 'edit') openManual(project);
  if (action === 'share') void shareTeamProject(project);
  if (action === 'unshare') void unshareTeamProject(project);
  if (action === 'sync-to-team') void syncLocalToTeam(project);
  if (action === 'sync-from-team') void syncTeamToLocal(project);
  if (action === 'compare-team') void confirmAction(teamDifferenceText(project), '閉じる');
  if (action === 'ai-update') openAiImport('update', project.projectId);
  if (action === 'copy-update') copyText(updatePrompt(project));
  if (action === 'architecture') location.hash = `#/project/${encodeURIComponent(project.projectId)}/architecture`;
  if (action === 'delete') deleteProject(project);
});

elements.architectureContent.addEventListener('click', (event) => {
  const action = event.target.closest('[data-architecture-action]')?.dataset.architectureAction;
  if (!action) return;
  const project = state.projects.find((item) => item.projectId === currentDetailId());
  if (!project) return;
  if (action === 'copy-prompt') copyText(architecturePrompt(), 'Codexキーフレーズ「概念図に反映」をコピーしました。');
  if (action === 'copy-json-prompt') copyText(architectureJsonPrompt(project), 'AI用の概念図JSON生成プロンプトをコピーしました。');
  if (action === 'import') openArchitectureImport(project);
  if (action === 'export') exportArchitecture(project);
  if (action === 'refresh') void renderArchitecturePage(project);
});

document.addEventListener('click', async (event) => {
  const menuItem = event.target.closest('.action-menu-panel button, .action-menu-panel a');
  if (menuItem) menuItem.closest('details.action-menu')?.removeAttribute('open');
  const button = event.target.closest('[data-copy-project-id]');
  if (!button) return;
  await copyText(button.dataset.copyProjectId, 'プロジェクトIDをコピーしました。');
});

[elements.search, elements.statusFilter, elements.ownerFilter, elements.sort].forEach((control) => {
  control.addEventListener(control === elements.search ? 'input' : 'change', renderList);
});

elements.deleteSamples.addEventListener('click', async () => {
  const count = state.projects.filter((project) => project.isSample === true).length;
  const confirmed = await confirmAction(`サンプルデータ${count}件を一括削除します。`, '削除する');
  if (!confirmed) return;
  try {
    await api('/api/sample-projects', { method: 'DELETE' });
    await loadProjects();
    showMessage('サンプルデータを削除しました。');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector('#confirm-ok').addEventListener('click', () => resolveConfirm(true));
document.querySelector('#confirm-cancel').addEventListener('click', () => resolveConfirm(false));
document.querySelector('#confirm-close').addEventListener('click', () => resolveConfirm(false));
elements.confirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  resolveConfirm(false);
});

window.addEventListener('hashchange', renderRoute);

Object.entries(STATUS_LABELS).forEach(([value, label]) => {
  elements.statusFilter.insertAdjacentHTML('beforeend', `<option value="${value}">${escapeHtml(label)}</option>`);
});

document.querySelector('#update-dismiss').addEventListener('click', () => {
  const version = elements.updateDownload.dataset.version;
  if (version) localStorage.setItem('pm-update-dismissed', version);
  elements.updateBanner.hidden = true;
});
void checkForUpdate();
loadProjects();

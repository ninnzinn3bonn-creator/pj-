const STORAGE_KEY = 'pm-team-viewer-token';
const $ = selector => document.querySelector(selector);
const statusLabels = {
  idea: 'アイデア', planning: '計画中', development: '開発中', testing: 'テスト中',
  release_ready: '公開準備完了', published: '公開済み', update_pending: '更新待ち',
  blocked: 'ブロック中', paused: '一時停止', archived: 'アーカイブ'
};

let token = '';
let projects = [];
let architectureViewer = null;

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function showMessage(text, error = false) {
  const element = $('#message');
  element.textContent = text;
  element.classList.toggle('error', error);
  element.hidden = !text;
}

function formatDate(value) {
  if (!value) return '更新日時なし';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

async function viewerApi() {
  const response = await fetch('/api/viewer/projects', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `通信に失敗しました（${response.status}）。`), { status: response.status });
  return data;
}

function projectSearchText(project) {
  return [project.name, project.projectId, project.summary, project.owner, ...(project.tags || [])].join(' ').toLocaleLowerCase('ja');
}

function filteredProjects() {
  const query = $('#search-input').value.trim().toLocaleLowerCase('ja');
  const status = $('#status-filter').value;
  return projects.filter(project => (!query || projectSearchText(project).includes(query)) && (!status || project.status === status));
}

function renderProjects() {
  const visible = filteredProjects();
  $('#project-count').textContent = `${visible.length} / ${projects.length}件`;
  $('#empty-state').hidden = visible.length > 0;
  $('#project-grid').innerHTML = visible.map(project => `
    <article class="project-card" data-project-id="${escapeHtml(project.projectId)}" tabindex="0">
      <div class="card-heading"><div><h2>${escapeHtml(project.name)}</h2><p class="project-id">${escapeHtml(project.projectId)}</p></div><span class="status status-${escapeHtml(project.status)}">${escapeHtml(statusLabels[project.status] || project.status)}</span></div>
      <p class="summary">${escapeHtml(project.summary || '概要は登録されていません。')}</p>
      <div class="progress-line"><div class="progress-track" aria-label="進捗 ${project.progress}%"><div class="progress-fill" style="width:${Number(project.progress) || 0}%"></div></div><strong>${Number(project.progress) || 0}%</strong></div>
      <div class="card-meta"><span>${escapeHtml(project.owner || '担当者未設定')}</span><span>${escapeHtml(formatDate(project.updatedAt))}</span></div>
      <div class="tag-list">${(project.tags || []).slice(0, 5).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
    </article>`).join('');
}

function listBlock(title, items) {
  const values = Array.isArray(items) ? items : [];
  return `<section class="detail-block"><h3>${escapeHtml(title)}</h3>${values.length ? `<ul>${values.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">なし</p>'}</section>`;
}

function openDetail(project) {
  $('#detail-title').textContent = project.name;
  const links = [
    safeExternalUrl(project.appUrl) && ['アプリを開く', safeExternalUrl(project.appUrl)],
    safeExternalUrl(project.developmentUrl) && ['開発環境を開く', safeExternalUrl(project.developmentUrl)],
    safeExternalUrl(project.repositoryUrl) && ['リポジトリを開く', safeExternalUrl(project.repositoryUrl)]
  ].filter(Boolean);
  $('#detail-content').innerHTML = `
    <div class="detail-summary"><span class="status status-${escapeHtml(project.status)}">${escapeHtml(statusLabels[project.status] || project.status)}</span><strong>${Number(project.progress) || 0}%</strong><span>${escapeHtml(project.owner || '担当者未設定')}</span></div>
    <p>${escapeHtml(project.summary || '概要は登録されていません。')}</p>
    ${listBlock('現在のタスク', project.currentTasks)}
    ${listBlock('次のタスク', project.nextTasks)}
    ${listBlock('ブロッカー', project.blockers)}
    <div class="detail-links">${links.map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`).join('')}</div>
    ${project.architecture ? `<button class="primary" data-open-architecture="${escapeHtml(project.projectId)}">概念図を見る</button>` : '<p class="muted">共有済みの概念図はありません。</p>'}
    <p class="detail-updated">最終更新 ${escapeHtml(formatDate(project.updatedAt))}${project.updatedBy ? ` · ${escapeHtml(project.updatedBy)}` : ''}</p>`;
  $('#detail-dialog').showModal();
}

function openArchitecture(project) {
  if (!project?.architecture) return;
  architectureViewer?.destroy?.();
  $('#architecture-title').textContent = `${project.name}の概念図`;
  const errors = window.ArchitectureViewer?.validate(project.architecture) || ['概念図Viewerを読み込めませんでした。'];
  if (errors.length) return showMessage(errors.join('\n'), true);
  $('#architecture-dialog').showModal();
  architectureViewer = window.ArchitectureViewer.mount($('#architecture-root'), { data: project.architecture, onNotify: showMessage });
}

async function connect(nextToken, { remember = true, quiet = false } = {}) {
  token = String(nextToken || '').trim();
  if (!token.startsWith('pmv_')) throw new Error('閲覧用トークン（pmv_から始まる値）を入力してください。');
  const data = await viewerApi();
  projects = Array.isArray(data.projects) ? data.projects : [];
  if (remember) localStorage.setItem(STORAGE_KEY, token); else localStorage.removeItem(STORAGE_KEY);
  $('#connect-view').hidden = true;
  $('#projects-view').hidden = false;
  $('#header-actions').hidden = false;
  $('#team-label').textContent = `チーム: ${data.team} · 閲覧専用`;
  const statuses = [...new Set(projects.map(project => project.status))].sort();
  $('#status-filter').innerHTML = '<option value="">すべて</option>' + statuses.map(status => `<option value="${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</option>`).join('');
  renderProjects();
  if (!quiet) showMessage('共有プロジェクトを読み込みました。');
}

function disconnect(message = '') {
  token = '';
  projects = [];
  localStorage.removeItem(STORAGE_KEY);
  $('#projects-view').hidden = true;
  $('#header-actions').hidden = true;
  $('#connect-view').hidden = false;
  $('#token-input').value = '';
  $('#team-label').textContent = '閲覧専用';
  showMessage(message, Boolean(message));
}

$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showMessage('');
  try { await connect($('#token-input').value, { remember: $('#remember-token').checked }); }
  catch (error) { showMessage(error.message, true); }
  finally { button.disabled = false; }
});

$('#refresh-button').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try { await connect(token, { remember: Boolean(localStorage.getItem(STORAGE_KEY)) }); }
  catch (error) {
    if ([401, 403].includes(error.status)) disconnect('閲覧用トークンが無効です。新しいトークンを入力してください。');
    else showMessage(error.message, true);
  } finally { event.currentTarget.disabled = false; }
});

$('#disconnect-button').addEventListener('click', () => disconnect());
$('#search-input').addEventListener('input', renderProjects);
$('#status-filter').addEventListener('change', renderProjects);
$('#project-grid').addEventListener('click', event => {
  const card = event.target.closest('[data-project-id]');
  if (card) openDetail(projects.find(project => project.projectId === card.dataset.projectId));
});
$('#project-grid').addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('[data-project-id]');
  if (card) { event.preventDefault(); openDetail(projects.find(project => project.projectId === card.dataset.projectId)); }
});
$('#detail-content').addEventListener('click', event => {
  const button = event.target.closest('[data-open-architecture]');
  if (button) openArchitecture(projects.find(project => project.projectId === button.dataset.openArchitecture));
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('#architecture-dialog').addEventListener('close', () => { architectureViewer?.destroy?.(); architectureViewer = null; $('#architecture-root').replaceChildren(); });

const savedToken = localStorage.getItem(STORAGE_KEY);
if (savedToken) {
  $('#token-input').value = savedToken;
  connect(savedToken, { remember: true, quiet: true }).catch(error => disconnect(error.status === 401 ? '保存済みトークンが無効です。新しいトークンを入力してください。' : error.message));
}

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

function progressTone(progress) {
  const value = progressValue(progress);
  if (value <= 33) return 'progress-low';
  if (value <= 66) return 'progress-middle';
  return 'progress-high';
}

function progressValue(progress) {
  return Math.max(0, Math.min(100, Number(progress) || 0));
}

function applyProgressWidths(root = document) {
  root.querySelectorAll('[data-progress]').forEach(fill => {
    fill.style.width = `${progressValue(fill.dataset.progress)}%`;
  });
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
      <div class="card-progress ${progressTone(project.progress)}">
        <div class="progress-caption"><span>進捗</span><strong>${Number(project.progress) || 0}%</strong></div>
        <div class="progress-track" role="progressbar" aria-label="${escapeHtml(project.name)}の進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressValue(project.progress)}"><div class="progress-fill" data-progress="${progressValue(project.progress)}"></div></div>
      </div>
      <div class="card-meta"><span>${escapeHtml(project.owner || '担当者未設定')}</span><span>${escapeHtml(formatDate(project.updatedAt))}</span></div>
      <p class="open-detail">詳細を見る <span aria-hidden="true">→</span></p>
    </article>`).join('');
  applyProgressWidths($('#project-grid'));
}

function listBlock(title, items) {
  const values = Array.isArray(items) ? items : [];
  return `<section class="detail-block"><h3>${escapeHtml(title)}</h3>${values.length ? `<ul>${values.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">なし</p>'}</section>`;
}

function detailLink(value) {
  const url = safeExternalUrl(value);
  return url ? `<a class="detail-url" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>` : '<span class="muted">未登録</span>';
}

function openDetail(project) {
  $('#detail-title').textContent = project.name;
  $('#detail-content').innerHTML = `
    <p class="detail-project-id">${escapeHtml(project.projectId)}</p>
    <table class="definition-table"><tbody>
      <tr><th scope="row">アプリURL</th><td>${detailLink(project.appUrl)}</td></tr>
      <tr><th scope="row">リポジトリURL</th><td>${detailLink(project.repositoryUrl)}</td></tr>
      <tr><th scope="row">開発環境URL</th><td>${detailLink(project.developmentUrl)}</td></tr>
      <tr><th scope="row">管理状態</th><td><span class="status status-${escapeHtml(project.status)}">${escapeHtml(statusLabels[project.status] || project.status)}</span></td></tr>
      <tr><th scope="row">進捗</th><td><div class="detail-progress ${progressTone(project.progress)}"><div class="progress-caption"><strong>${progressValue(project.progress)}%</strong></div><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressValue(project.progress)}"><div class="progress-fill" data-progress="${progressValue(project.progress)}"></div></div></div></td></tr>
      <tr><th scope="row">担当者</th><td>${escapeHtml(project.owner || '—')}</td></tr>
      <tr><th scope="row">タグ</th><td><div class="tag-list">${(project.tags || []).length ? project.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('') : '<span class="muted">なし</span>'}</div></td></tr>
      <tr><th scope="row">最終更新</th><td>${escapeHtml(formatDate(project.updatedAt))}${project.updatedBy ? `<br><span class="muted">${escapeHtml(project.updatedBy)}</span>` : ''}</td></tr>
    </tbody></table>
    <section class="detail-block detail-overview"><h3>現在の状況</h3><p>${escapeHtml(project.summary || '記載なし')}</p></section>
    ${listBlock('現在作業中の項目', project.currentTasks)}
    ${listBlock('次に行う作業', project.nextTasks)}
    ${listBlock('問題・ブロッカー', project.blockers)}
    <section class="detail-block architecture-card"><h3>プロジェクト概念図</h3>${project.architecture ? `<p>共有済みの概念図を閲覧できます。</p><button class="primary" data-open-architecture="${escapeHtml(project.projectId)}">概念図を見る</button>` : '<p class="muted">共有済みの概念図はありません。</p>'}</section>`;
  applyProgressWidths($('#detail-content'));
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

const $ = selector => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `通信に失敗しました（${response.status}）。`), { status: response.status });
  return data;
}

let messageTimer;
let currentSession;
function message(text, error = false) {
  clearTimeout(messageTimer);
  $('#message').textContent = text;
  $('#message').classList.toggle('error', error);
  $('#message').hidden = false;
  messageTimer = setTimeout(() => { $('#message').hidden = true; }, 5000);
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function loadMembers() {
  try {
    const data = await api('/api/members');
    $('#members-section').hidden = false;
    $('#member-list').innerHTML = data.members.map(member => `<li><span><strong>${escapeHtml(member.email)}</strong> · ${escapeHtml(member.role)}</span>${member.role === 'admin' ? '' : `<button data-remove-member="${member.id}">解除</button>`}</li>`).join('');
  } catch (error) {
    if (error.status !== 403) message(error.message, true);
  }
}

async function initialize() {
  try {
    const session = await api('/api/session');
    currentSession = session;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#user-label').hidden = false;
    $('#logout-link').hidden = false;
    $('#user-label').textContent = session.user.email;
    $('#team-note').textContent = `チーム: ${session.team}。プロジェクトは認証付きD1 APIからローカル台帳へ同期されます。`;
    $('#team-select').innerHTML = session.teams.map(team => `<option value="${escapeHtml(team.teamSlug)}"${team.teamSlug === session.team ? ' selected' : ''}>${escapeHtml(team.name)} (${escapeHtml(team.role)})</option>`).join('');
    await loadMembers();
  } catch (error) {
    if (error.status !== 401) message(error.message, true);
  }
}

$('#connection-button').addEventListener('click', async () => {
  try {
    const data = await api('/api/connection-token', { method: 'POST' });
    $('#team-url').value = data.teamUrl;
    $('#connection-team').value = data.team;
    $('#connection-token').value = data.token;
    $('#connection-dialog').showModal();
  } catch (error) { message(error.message, true); }
});

$('#team-select').addEventListener('change', async event => {
  try {
    await api('/api/session/team', { method: 'POST', body: JSON.stringify({ teamSlug: event.target.value }) });
    await initialize();
    message('チームを切り替えました。接続情報は改めて発行してください。');
  } catch (error) { message(error.message, true); await initialize(); }
});

$('#team-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/api/teams', { method: 'POST', body: JSON.stringify({ name: $('#team-name').value.trim() }) });
    $('#team-name').value = '';
    await initialize();
    message('新しいチームを作成しました。');
  } catch (error) { message(error.message, true); } finally { button.disabled = false; }
});

$('#copy-connection').addEventListener('click', async () => {
  const text = `チーム台帳URL: ${$('#team-url').value}\nチームID: ${$('#connection-team').value}\n接続トークン: ${$('#connection-token').value}`;
  try { await navigator.clipboard.writeText(text); message('接続情報をコピーしました。'); } catch { message('コピーできませんでした。', true); }
});

$('#member-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/api/members', { method: 'POST', body: JSON.stringify({ email: $('#member-email').value.trim(), role: 'member' }) });
    $('#member-email').value = '';
    await loadMembers();
    message('チームメンバーを追加しました。');
  } catch (error) { message(error.message, true); } finally { button.disabled = false; }
});

$('#member-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-member]');
  if (!button || !confirm('このメンバーのチームアクセスを解除しますか？')) return;
  button.disabled = true;
  try { await api(`/api/members/${button.dataset.removeMember}`, { method: 'DELETE' }); await loadMembers(); message('アクセスを解除しました。'); }
  catch (error) { message(error.message, true); button.disabled = false; }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
initialize();

"use strict";

const STATUS_LABELS = {
  idea: "構想",
  planning: "設計中",
  development: "開発中",
  testing: "テスト中",
  release_ready: "公開準備完了",
  published: "公開済み",
  update_pending: "アップデート待ち",
  blocked: "問題発生",
  paused: "一時停止",
  archived: "終了・保管",
};
const state = { projects: [], editing: null };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const lines = (value) =>
  String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
const formatDate = (value) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? { "Content-Type": "application/json", ...(options.headers || {}) }
      : options.headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error || `通信に失敗しました（${response.status}）。`,
    );
    error.status = response.status;
    error.code = data.code;
    error.latest = data.latest;
    throw error;
  }
  return data;
}
let messageTimer;
function message(text, error = false) {
  clearTimeout(messageTimer);
  const element = $("#message");
  element.textContent = text;
  element.classList.toggle("error", error);
  element.hidden = false;
  messageTimer = setTimeout(() => {
    element.hidden = true;
  }, 6000);
}
function options(selected) {
  return Object.entries(STATUS_LABELS)
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`,
    )
    .join("");
}

function attachGraphButtons(grid) {
  grid.querySelectorAll('.card-actions').forEach((actions, index) => {
    if (!state.projects[index].architecture) return;
    const button = document.createElement('button');
    button.textContent = '概念図';
    button.addEventListener('click', () => {
      state.viewer?.destroy();
      $('#graph-section').hidden = false;
      state.viewer = window.ArchitectureViewer.mount($('#graph-root'), { data: state.projects[index].architecture, onNotify: message });
      $('#graph-section').scrollIntoView();
    });
    actions.prepend(button);
  });
}

function render() {
  const grid = $("#project-grid");
  $("#project-count").textContent =
    `${state.projects.length}件 / GitHubの共有データ`;
  $("#empty-state").hidden = state.projects.length !== 0;
  grid.innerHTML = state.projects
    .map(
      (project) =>
        `<article class="project-card"><div class="card-heading"><div><h3>${escapeHtml(project.name)}</h3><span class="project-id">${escapeHtml(project.projectId)}</span></div><span class="status">${escapeHtml(STATUS_LABELS[project.status] || project.status)}</span></div><p class="summary">${escapeHtml(project.summary || "概要なし")}</p><div class="progress-line"><strong>${project.progress}%</strong><div class="progress-track" role="progressbar" aria-valuenow="${project.progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${project.progress}%"></div></div></div><div class="task-summary"><span>作業中 ${project.currentTasks?.length || 0}</span><span>次 ${project.nextTasks?.length || 0}</span><span>問題 ${project.blockers?.length || 0}</span>${project.architecture ? `<span>概念図 ${project.architecture.components?.length || 0}要素</span>` : ""}</div><p class="meta">担当 ${escapeHtml(project.owner || "未設定")} / ${escapeHtml(project.updatedBy || "—")} が ${escapeHtml(formatDate(project.updatedAt))} に更新</p><div class="card-actions"><button data-edit="${escapeHtml(project.projectId)}">編集</button></div></article>`,
    )
    .join("");
  attachGraphButtons(grid);
}

async function load() {
  try {
    const session = await api("/api/session");
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    $("#user-label").hidden = false;
    $("#connection-button").hidden = false;
    $("#logout-link").hidden = false;
    $("#user-label").textContent = `@${session.user.login}`;
    $("#team-note").textContent = `チーム: ${session.team}`;
    const data = await api("/api/projects");
    state.projects = data.projects;
    render();
  } catch (error) {
    if (error.status === 401) {
      $("#login-view").hidden = false;
      $("#app-view").hidden = true;
    } else message(error.message, true);
  }
}
function openEdit(project) {
  state.editing = project;
  const form = $("#edit-form").elements;
  $("#edit-title").textContent = project.name;
  $("#edit-meta").textContent =
    `ID: ${project.projectId} / 最終更新: ${formatDate(project.updatedAt)} / ${project.updatedBy || "—"}`;
  form.name.value = project.name;
  form.status.innerHTML = options(project.status);
  form.progress.value = project.progress;
  form.owner.value = project.owner || "";
  form.summary.value = project.summary || "";
  form.currentTasks.value = (project.currentTasks || []).join("\n");
  form.nextTasks.value = (project.nextTasks || []).join("\n");
  form.blockers.value = (project.blockers || []).join("\n");
  $("#edit-error").hidden = true;
  $("#edit-dialog").showModal();
}
async function save(event) {
  event.preventDefault();
  if (!state.editing) return;
  const form = event.currentTarget.elements;
  const project = {
    ...state.editing,
    name: form.name.value.trim(),
    status: form.status.value,
    progress: Number(form.progress.value),
    owner: form.owner.value.trim(),
    summary: form.summary.value.trim(),
    currentTasks: lines(form.currentTasks.value),
    nextTasks: lines(form.nextTasks.value),
    blockers: lines(form.blockers.value),
  };
  delete project.revision;
  delete project.history;
  delete project.updatedAt;
  delete project.updatedBy;
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(state.editing.projectId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          project,
          expectedRevision: state.editing.revision,
        }),
      },
    );
    state.projects = state.projects.map((item) =>
      item.projectId === result.project.projectId ? result.project : item,
    );
    render();
    $("#edit-dialog").close();
    message("共有プロジェクトを更新しました。");
  } catch (error) {
    if (error.code === "PROJECT_CONFLICT" && error.latest) {
      state.projects = state.projects.map((item) =>
        item.projectId === error.latest.projectId ? error.latest : item,
      );
      render();
      openEdit(error.latest);
      $("#edit-error").textContent =
        `${error.message}\n@${error.latest.updatedBy || "別のメンバー"} の ${formatDate(error.latest.updatedAt)} の更新を読み込みました。内容を確認してもう一度編集してください。`;
      $("#edit-error").hidden = false;
      state.editing = error.latest;
    } else {
      $("#edit-error").textContent = error.message;
      $("#edit-error").hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}
async function connection() {
  try {
    const data = await api("/api/connection-token", { method: "POST" });
    $("#team-url").value = data.teamUrl;
    $("#connection-token").value = data.token;
    $("#connection-dialog").showModal();
  } catch (error) {
    message(error.message, true);
  }
}
async function copyConnection() {
  const text = `チーム台帳URL: ${$("#team-url").value}\n接続トークン: ${$("#connection-token").value}`;
  try {
    await navigator.clipboard.writeText(text);
    message("接続情報をコピーしました。");
  } catch {
    message(
      "コピーできませんでした。入力欄から手動でコピーしてください。",
      true,
    );
  }
}

$("#project-grid").addEventListener("click", (event) => {
  const id = event.target.closest("[data-edit]")?.dataset.edit;
  if (id) openEdit(state.projects.find((item) => item.projectId === id));
});
$("#edit-form").addEventListener("submit", save);
$("#refresh-button").addEventListener("click", load);
$("#connection-button").addEventListener("click", connection);
$("#copy-connection").addEventListener("click", copyConnection);
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
$('#graph-close').addEventListener('click', () => { state.viewer?.destroy(); state.viewer = null; $('#graph-section').hidden = true; });
load();

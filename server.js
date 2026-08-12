'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { version: APP_VERSION } = require('./package.json');
const {
  architectureRevision,
  compareArchitectures,
  countsFor,
  ensureRoot: ensureArtifactsRoot,
  extractArchitectureJson,
  listRecords: listArchitectureRecords,
  makeRecord: makeArchitectureRecord,
  readRecord: readArchitectureRecord,
  recordMeta: architectureRecordMeta,
  recordRequest: recordArchitectureRequest,
  stageProjectRemoval: stageProjectArtifactRemoval,
  validateForProject: validateArchitectureForProject,
  writeRecordAtomic: writeArchitectureRecordAtomic
} = require('./lib/architecture-artifacts');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 4170);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT_DIR, 'data', 'projects.json');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(path.dirname(DATA_FILE), 'artifacts');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STATUSES = [
  'idea',
  'planning',
  'development',
  'testing',
  'release_ready',
  'published',
  'update_pending',
  'blocked',
  'paused',
  'archived'
];
const STATUS_ALIASES = new Map([
  ['todo', 'idea'],
  ['not_started', 'idea'],
  ['backlog', 'planning'],
  ['in_progress', 'development'],
  ['inprogress', 'development'],
  ['in_development', 'development'],
  ['complete', 'published'],
  ['completed', 'published'],
  ['done', 'published'],
  ['release_ready', 'release_ready'],
  ['release-ready', 'release_ready'],
  ['release ready', 'release_ready'],
  ['idea', 'idea'],
  ['アイデア', 'idea'],
  ['構想', 'idea'],
  ['planning', 'planning'],
  ['計画中', 'planning'],
  ['企画中', 'planning'],
  ['development', 'development'],
  ['開発中', 'development'],
  ['進行中', 'development'],
  ['testing', 'testing'],
  ['テスト中', 'testing'],
  ['検証中', 'testing'],
  ['リリース準備', 'release_ready'],
  ['公開準備', 'release_ready'],
  ['published', 'published'],
  ['公開済み', 'published'],
  ['完了', 'published'],
  ['update_pending', 'update_pending'],
  ['更新待ち', 'update_pending'],
  ['blocked', 'blocked'],
  ['ブロック', 'blocked'],
  ['paused', 'paused'],
  ['一時停止', 'paused'],
  ['archived', 'archived'],
  ['アーカイブ済み', 'archived']
]);
const UPDATE_SOURCES = ['web', 'web-ai', 'cli', 'codex-skill', 'backup'];
const MAX_APPLIED_REQUESTS = 500;

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

let writeQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function apiError(status, message, details = [], apiCode = '') {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  error.apiCode = apiCode;
  return error;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSource(value, fallback = 'web') {
  const source = cleanString(value);
  return UPDATE_SOURCES.includes(source) ? source : fallback;
}

function normalizeStatus(value) {
  const raw = cleanString(value).normalize('NFKC').toLowerCase();
  const compact = raw.replace(/[\s-]+/g, '_');
  return STATUS_ALIASES.get(raw) || STATUS_ALIASES.get(compact) || raw;
}

function normalizeRequestId(value) {
  const requestId = cleanString(value);
  if (!requestId) return '';
  if (requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    throw apiError(400, 'request_idの形式が正しくありません。', [
      'request_idは128文字以内の英数字、ハイフン、ピリオド、アンダースコア、コロンで指定してください。'
    ]);
  }
  return requestId;
}

function cleanStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field}は配列で指定してください。`);
    return [];
  }
  if (value.some((item) => typeof item !== 'string')) {
    errors.push(`${field}の各項目は文字列で指定してください。`);
  }
  return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function validateUrl(value, label, errors) {
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      errors.push(`${label}はhttp://またはhttps://で始まるURLにしてください。`);
    }
  } catch {
    errors.push(`${label}の形式が正しくありません。`);
  }
}

function normalizedRepositoryUrl(value) {
  const repositoryUrl = cleanString(value);
  if (!repositoryUrl) return '';
  try {
    const parsed = new URL(repositoryUrl);
    parsed.hash = '';
    parsed.search = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return repositoryUrl.toLowerCase().replace(/\/+$/, '').replace(/\.git$/i, '');
  }
}

function assertRepositoryUrlAvailable(store, project) {
  const expected = normalizedRepositoryUrl(project.repositoryUrl);
  if (!expected) return;
  const conflict = store.projects.find((item) => item.projectId !== project.projectId
    && normalizedRepositoryUrl(item.repositoryUrl) === expected);
  if (conflict) {
    throw apiError(409, '同じrepository_urlのプロジェクトが既に登録されています。', [
      conflict.projectId,
      project.repositoryUrl
    ], 'REPOSITORY_CONFLICT');
  }
}

function generateProjectId(name) {
  const ascii = cleanString(name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  if (ascii) return ascii;
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `project-${stamp}`;
}

function validateProjectInput(input, { allowMissingId = false } = {}) {
  const errors = [];
  const projectId = cleanString(input.projectId);
  const name = cleanString(input.name);
  const status = normalizeStatus(input.status);
  const progress = Number(input.progress);
  const appUrl = cleanString(input.appUrl);
  const adminUrl = cleanString(input.adminUrl);
  const repositoryUrl = cleanString(input.repositoryUrl);
  const developmentUrl = cleanString(input.developmentUrl);

  if (!allowMissingId && !projectId) errors.push('プロジェクトIDは必須です。');
  if (projectId && !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(projectId)) {
    errors.push('プロジェクトIDは英数字とハイフンで指定してください。');
  }
  if (!name) errors.push('プロジェクト名は必須です。');
  if (!STATUSES.includes(status)) errors.push('statusが許可されていません。');
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    errors.push('progressは0から100の整数で指定してください。');
  }
  validateUrl(appUrl, 'アプリURL', errors);
  validateUrl(adminUrl, '管理者サイトURL', errors);
  validateUrl(repositoryUrl, 'リポジトリURL', errors);
  validateUrl(developmentUrl, '開発環境URL', errors);

  const tags = cleanStringArray(input.tags ?? [], 'タグ', errors);
  const currentTasks = cleanStringArray(input.currentTasks ?? [], '現在のタスク', errors);
  const nextTasks = cleanStringArray(input.nextTasks ?? [], '次のタスク', errors);
  const blockers = cleanStringArray(input.blockers ?? [], 'ブロッカー', errors);

  if (errors.length) throw apiError(400, errors[0], errors);

  return {
    projectId,
    name,
    appUrl,
    adminUrl,
    repositoryUrl,
    developmentUrl,
    status,
    progress,
    owner: cleanString(input.owner),
    tags,
    summary: cleanString(input.summary),
    currentTasks,
    nextTasks,
    blockers
  };
}

function validateAiPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw apiError(400, 'JSONの構造が正しくありません。', ['JSONの最上位はオブジェクトにしてください。']);
  }

  const required = [
    'schema_version', 'mode', 'project_id', 'name', 'app_url', 'repository_url',
    'development_url', 'status', 'progress', 'owner', 'tags', 'summary',
    'current_tasks', 'next_tasks', 'blockers', 'updated_at'
  ];
  const missing = required.filter((key) => !(key in payload));
  if (missing.length) {
    throw apiError(400, '必須項目が不足しています。', missing.map((key) => `${key}がありません。`));
  }
  if (payload.schema_version !== 1) {
    throw apiError(400, 'schema_versionが未対応です。', ['schema_versionは1を指定してください。']);
  }
  if (!['create', 'update'].includes(payload.mode)) {
    throw apiError(400, 'modeが正しくありません。', ['modeはcreateまたはupdateを指定してください。']);
  }
  if (!cleanString(payload.updated_at) || Number.isNaN(Date.parse(payload.updated_at))) {
    throw apiError(400, 'updated_atの形式が正しくありません。', ['updated_atはISO 8601形式で指定してください。']);
  }

  const project = validateProjectInput({
    projectId: payload.project_id,
    name: payload.name,
    appUrl: payload.app_url,
    adminUrl: payload.admin_url,
    repositoryUrl: payload.repository_url,
    developmentUrl: payload.development_url,
    status: payload.status,
    progress: payload.progress,
    owner: payload.owner,
    tags: payload.tags,
    summary: payload.summary,
    currentTasks: payload.current_tasks,
    nextTasks: payload.next_tasks,
    blockers: payload.blockers
  });

  return {
    mode: payload.mode,
    project: {
      ...project,
      updatedAt: new Date(payload.updated_at).toISOString()
    }
  };
}

function extractAiJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw apiError(400, 'JSONが見つかりません。', ['貼り付け内容が空です。']);
  }

  const trimmed = text.trim();
  const blocks = [];
  const fencePattern = /```(?:project-status|json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(trimmed)) !== null) blocks.push(match[1].trim());
  const candidates = blocks.length ? blocks : [trimmed];
  const syntaxErrors = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      syntaxErrors.push(error.message);
    }
  }

  if (!blocks.length && !trimmed.startsWith('{')) {
    throw apiError(400, 'JSONが見つかりません。', ['project-statusまたはjsonコードブロック、もしくは生JSONを貼り付けてください。']);
  }
  throw apiError(400, 'JSONの構文が正しくありません。', syntaxErrors.slice(0, 3));
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await ensureArtifactsRoot(ARTIFACTS_DIR);
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ schemaVersion: 1, projects: [] }, null, 2), 'utf8');
  }
}

async function readStore() {
  await ensureDataFile();
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (error) {
    throw apiError(500, 'データファイルを読み込めません。', [error.message]);
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) {
    throw apiError(500, 'データファイルの構造が正しくありません。');
  }
  parsed.projects = parsed.projects.map((project) => ({
    ...project,
    adminUrl: cleanString(project.adminUrl)
  }));
  return parsed;
}

async function writeStoreAtomic(store) {
  const directory = path.dirname(DATA_FILE);
  const temporaryFile = path.join(directory, `.projects-${process.pid}-${Date.now()}.tmp`);
  const handle = await fs.open(temporaryFile, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryFile, DATA_FILE);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true });
    throw error;
  }
}

function withWriteLock(operation) {
  const queued = writeQueue.then(operation, operation);
  writeQueue = queued.catch(() => undefined);
  return queued;
}

function makeHistoryEntry(before, after, metadata = {}) {
  return {
    updatedAt: after.updatedAt,
    progressBefore: before.progress,
    progressAfter: after.progress,
    statusBefore: before.status,
    statusAfter: after.status,
    summaryAfter: after.summary,
    source: normalizeSource(metadata.source || after.lastUpdateSource),
    ...(metadata.requestId ? { requestId: metadata.requestId } : {})
  };
}

function createProject(project, extra = {}) {
  const timestamp = extra.updatedAt || nowIso();
  const source = normalizeSource(extra.source || extra.lastUpdateSource);
  return {
    ...project,
    createdAt: extra.createdAt || timestamp,
    updatedAt: timestamp,
    createdSource: normalizeSource(extra.createdSource || source),
    lastUpdateSource: source,
    history: Array.isArray(extra.history) ? extra.history : [],
    ...(extra.isSample ? { isSample: true } : {})
  };
}

function updateProject(before, changes, suppliedUpdatedAt = '', metadata = {}) {
  const candidate = validateProjectInput({ ...before, ...changes, projectId: before.projectId });
  const updatedAt = suppliedUpdatedAt && !Number.isNaN(Date.parse(suppliedUpdatedAt))
    ? new Date(suppliedUpdatedAt).toISOString()
    : nowIso();
  const source = normalizeSource(metadata.source);
  const after = {
    ...before,
    ...candidate,
    projectId: before.projectId,
    createdAt: before.createdAt,
    updatedAt,
    createdSource: normalizeSource(before.createdSource),
    lastUpdateSource: source,
    history: [...(Array.isArray(before.history) ? before.history : [])]
  };
  after.history.push(makeHistoryEntry(before, after, {
    source,
    requestId: metadata.requestId
  }));
  return after;
}

function projectPayloadFingerprint(parsed) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ mode: parsed.mode, project: parsed.project }))
    .digest('hex');
}

function findAppliedRequest(store, requestId) {
  if (!requestId || !Array.isArray(store.appliedRequests)) return null;
  return store.appliedRequests.find((item) => item.requestId === requestId) || null;
}

function recordAppliedRequest(store, entry) {
  const current = Array.isArray(store.appliedRequests) ? store.appliedRequests : [];
  store.appliedRequests = [...current, entry].slice(-MAX_APPLIED_REQUESTS);
}

function compareProjects(before, after) {
  const fields = [
    ['status', '状態'],
    ['progress', '進捗'],
    ['summary', '概要'],
    ['currentTasks', '現在のタスク'],
    ['nextTasks', '次のタスク'],
    ['blockers', 'ブロッカー'],
    ['appUrl', 'アプリURL'],
    ['adminUrl', '管理者サイトURL'],
    ['repositoryUrl', 'リポジトリURL'],
    ['developmentUrl', '開発環境URL'],
    ['owner', '担当者'],
    ['tags', 'タグ']
  ];
  return fields.map(([key, label]) => ({
    key,
    label,
    before: before ? before[key] : null,
    after: after[key],
    changed: before ? JSON.stringify(before[key]) !== JSON.stringify(after[key]) : true
  }));
}

function architectureFromRequestBody(body) {
  if (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
  if (body && typeof body.data === 'string') return extractArchitectureJson(body.data);
  return extractArchitectureJson(body?.text);
}

function architectureMeta(projectId, record = null) {
  if (!record) {
    return {
      projectId,
      state: 'missing',
      hasValidDocument: false,
      analyzedAt: '',
      counts: { groups: 0, components: 0, edges: 0, flows: 0 },
      lastError: null,
      revision: null,
      updatedAt: '',
      source: ''
    };
  }
  const stored = architectureRecordMeta(record);
  return {
    projectId,
    state: 'ready',
    hasValidDocument: true,
    analyzedAt: record.architecture.project.analyzed_at || stored.generatedAt || '',
    counts: stored.counts,
    lastError: null,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    source: stored.source
  };
}

function architectureTemplate(project) {
  const now = nowIso();
  return {
    schema_version: 1,
    kind: 'architecture-graph',
    document: { id: `${project.projectId}-architecture`, title: `${project.name} architecture`, summary: '空の概念図テンプレート', generated_at: now },
    project: {
      project_id: project.projectId, name: project.name, summary: project.summary || '', version: '', analyzed_at: now,
      source_root: '.', app_url: project.appUrl || '', admin_url: project.adminUrl || '', repository_url: project.repositoryUrl || '',
      development_url: project.developmentUrl || '', status: project.status || '', progress: Number.isInteger(project.progress) ? project.progress : 0,
      tags: Array.isArray(project.tags) ? project.tags : []
    },
    groups: [
      { id: 'actors', name: 'Actors', description: 'Users and external actors', color: '#F59E0B' },
      { id: 'client', name: 'Client', description: 'Browser or app-facing components', color: '#3B82F6' },
      { id: 'services', name: 'Services', description: 'Application and infrastructure services', color: '#8B5CF6' },
      { id: 'data', name: 'Data', description: 'Persistent and local data stores', color: '#64748B' },
      { id: 'operations', name: 'Operations', description: 'Build, deployment, and operations', color: '#E11D48' }
    ], components: [], edges: [], flows: [],
    presentation: { layout: 'left-to-right', primary_flow: '', group_order: ['actors', 'client', 'services', 'data', 'operations'] },
    extensions: { template: true, template_style: 'human-stack-battle-20260715' }
  };
}

function assertProjectExists(store, projectId) {
  const project = store.projects.find((item) => item.projectId === projectId);
  if (!project) throw apiError(404, '指定されたプロジェクトが見つかりません。');
  return project;
}

function validateBackup(data) {
  if (!data || typeof data !== 'object' || ![1, 2].includes(data.schemaVersion) || !Array.isArray(data.projects)) {
    throw apiError(400, 'バックアップJSONの構造が正しくありません。', ['schemaVersion: 1または2とprojects配列が必要です。']);
  }
  const ids = new Set();
  const projects = data.projects.map((item, index) => {
    let normalized;
    try {
      normalized = validateProjectInput(item);
    } catch (error) {
      throw apiError(400, `${index + 1}件目のプロジェクトが正しくありません。`, error.details || [error.message]);
    }
    if (ids.has(normalized.projectId)) {
      throw apiError(400, 'バックアップ内に重複したプロジェクトIDがあります。', [normalized.projectId]);
    }
    ids.add(normalized.projectId);
    const createdAt = !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : nowIso();
    const updatedAt = !Number.isNaN(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toISOString() : createdAt;
    return createProject(normalized, {
      createdAt,
      updatedAt,
      history: Array.isArray(item.history) ? item.history : [],
      createdSource: item.createdSource,
      lastUpdateSource: item.lastUpdateSource,
      isSample: item.isSample === true
    });
  });
  const architectures = [];
  if (data.schemaVersion === 2) {
    if (!Array.isArray(data.architectures)) {
      throw apiError(400, 'バックアップJSONの構造が正しくありません。', ['schemaVersion: 2ではarchitectures配列が必要です。']);
    }
    const architectureIds = new Set();
    const projectIds = new Set(projects.map((project) => project.projectId));
    data.architectures.forEach((architecture, index) => {
      const projectId = architecture?.project?.project_id;
      if (!projectIds.has(projectId)) {
        throw apiError(400, `${index + 1}件目の概念図に対応するプロジェクトがバックアップ内にありません。`, [projectId || 'project_id未指定']);
      }
      if (architectureIds.has(projectId)) {
        throw apiError(400, 'バックアップ内に同じプロジェクトの概念図が重複しています。', [projectId]);
      }
      try {
        validateArchitectureForProject(architecture, projectId);
      } catch (error) {
        throw apiError(400, `${index + 1}件目の概念図が正しくありません。`, error.details || [error.message]);
      }
      architectureIds.add(projectId);
      architectures.push(architecture);
    });
  }
  return {
    sourceSchemaVersion: data.schemaVersion,
    store: { schemaVersion: 1, projects },
    architectures
  };
}

async function stageArtifactReplacement(records) {
  const parentDirectory = path.dirname(path.resolve(ARTIFACTS_DIR));
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const stagingDirectory = path.join(parentDirectory, `.artifacts-stage-${token}`);
  const previousDirectory = path.join(parentDirectory, `.artifacts-previous-${token}`);
  await ensureArtifactsRoot(stagingDirectory);
  try {
    for (const record of records) await writeArchitectureRecordAtomic(stagingDirectory, record);
    await ensureArtifactsRoot(ARTIFACTS_DIR);
    await fs.rename(ARTIFACTS_DIR, previousDirectory);
    try {
      await fs.rename(stagingDirectory, ARTIFACTS_DIR);
    } catch (error) {
      await fs.rename(previousDirectory, ARTIFACTS_DIR);
      throw error;
    }
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    async rollback() {
      await fs.rm(ARTIFACTS_DIR, { recursive: true, force: true });
      await fs.rename(previousDirectory, ARTIFACTS_DIR);
    },
    async commit() {
      await fs.rm(previousDirectory, { recursive: true, force: true });
    }
  };
}

async function stageProjectArtifactRemovals(projectIds) {
  const staged = [];
  try {
    for (const projectId of projectIds) {
      const removal = await stageProjectArtifactRemoval(ARTIFACTS_DIR, projectId);
      if (removal) staged.push(removal);
    }
  } catch (error) {
    for (const removal of staged.reverse()) await removal.rollback();
    throw error;
  }
  return {
    async rollback() {
      for (const removal of [...staged].reverse()) await removal.rollback();
    },
    async commit() {
      for (const removal of staged) await removal.commit();
    }
  };
}

async function backupArtifactRecords(store, backup, strategy) {
  const recordsById = new Map();
  if (strategy === 'merge') {
    const existing = await listArchitectureRecords(ARTIFACTS_DIR, store.projects.map((item) => item.projectId));
    existing.forEach((record) => recordsById.set(record.projectId, record));
  }
  backup.architectures.forEach((architecture) => {
    const projectId = architecture.project.project_id;
    recordsById.set(projectId, makeArchitectureRecord(projectId, architecture, { source: 'backup' }));
  });
  const allowedIds = new Set(backup.store.projects.map((item) => item.projectId));
  if (strategy === 'merge') store.projects.forEach((item) => allowedIds.add(item.projectId));
  return [...recordsById.values()].filter((record) => allowedIds.has(record.projectId));
}

function sendJson(response, status, data, headers = {}) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function sendError(response, error) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(error);
  sendJson(response, status, {
    error: error.message || 'サーバーエラーが発生しました。',
    details: Array.isArray(error.details) ? error.details : [],
    ...(error.apiCode ? { code: error.apiCode } : {})
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw apiError(413, '送信データが大きすぎます。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw apiError(400, 'リクエストJSONの構文が正しくありません。');
  }
}

function backupFilename() {
  const date = new Date();
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `project-manager-backup-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.json`;
}

async function handleApi(request, response, url) {
  const method = request.method;
  const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));

  if (method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, {
      service: 'local-project-manager',
      version: APP_VERSION,
      schemaVersion: 1,
      status: 'ok',
      timestamp: nowIso()
    });
  }

  if (method === 'GET' && url.pathname === '/api/meta') {
    return sendJson(response, 200, {
      service: 'local-project-manager',
      version: APP_VERSION,
      schemaVersion: 1,
      cliCommand: 'project-manager',
      supportedSources: UPDATE_SOURCES,
      triggerPhrases: {
        preview: '進捗を確認',
        apply: '進捗に反映'
      }
    });
  }

  if (method === 'GET' && url.pathname === '/api/projects') {
    const store = await readStore();
    return sendJson(response, 200, { schemaVersion: store.schemaVersion, projects: store.projects });
  }

  if (method === 'GET' && url.pathname === '/api/export') {
    const store = await readStore();
    const records = await listArchitectureRecords(ARTIFACTS_DIR, store.projects.map((item) => item.projectId));
    return sendJson(response, 200, {
      schemaVersion: 2,
      projects: store.projects,
      architectures: records.map((record) => record.architecture)
    }, {
      'Content-Disposition': `attachment; filename="${backupFilename()}"`
    });
  }

  const isArchitectureRoute = segments.length >= 5
    && segments[0] === 'api'
    && segments[1] === 'projects'
    && segments[3] === 'artifacts'
    && segments[4] === 'architecture';

  if (isArchitectureRoute && method === 'GET' && segments.length === 6 && segments[5] === 'meta') {
    const projectId = segments[2];
    const store = await readStore();
    assertProjectExists(store, projectId);
    const record = await readArchitectureRecord(ARTIFACTS_DIR, projectId);
    return sendJson(response, 200, architectureMeta(projectId, record));
  }

  if (isArchitectureRoute && method === 'GET' && segments.length === 6 && segments[5] === 'template') {
    const projectId = segments[2];
    const store = await readStore();
    const project = assertProjectExists(store, projectId);
    return sendJson(response, 200, { architecture: architectureTemplate(project), projectId, mode: 'template' });
  }

  if (isArchitectureRoute && method === 'GET' && segments.length === 5) {
    const projectId = segments[2];
    const store = await readStore();
    assertProjectExists(store, projectId);
    const record = await readArchitectureRecord(ARTIFACTS_DIR, projectId);
    if (!record) throw apiError(404, 'このプロジェクトの概念図はまだ作成されていません。');
    return sendJson(response, 200, {
      architecture: record.architecture,
      meta: architectureMeta(projectId, record)
    }, {
      ETag: `"${record.revision}"`,
      'X-Architecture-Revision': record.revision
    });
  }

  if (isArchitectureRoute && method === 'GET' && segments.length === 6 && segments[5] === 'export') {
    const projectId = segments[2];
    const store = await readStore();
    assertProjectExists(store, projectId);
    const record = await readArchitectureRecord(ARTIFACTS_DIR, projectId);
    if (!record) throw apiError(404, 'このプロジェクトの概念図はまだ作成されていません。');
    return sendJson(response, 200, record.architecture, {
      'Content-Disposition': `attachment; filename="${projectId}-architecture.json"`,
      ETag: `"${record.revision}"`,
      'X-Architecture-Revision': record.revision
    });
  }

  if (isArchitectureRoute && method === 'POST' && segments.length === 6 && segments[5] === 'preview') {
    const projectId = segments[2];
    const body = await readJsonBody(request);
    const architecture = validateArchitectureForProject(architectureFromRequestBody(body), projectId);
    const store = await readStore();
    assertProjectExists(store, projectId);
    const existing = await readArchitectureRecord(ARTIFACTS_DIR, projectId);
    const proposedRevision = architectureRevision(architecture);
    const unchanged = existing?.revision === proposedRevision;
    return sendJson(response, 200, {
      projectId,
      mode: existing ? 'update' : 'create',
      exists: Boolean(existing),
      changed: !unchanged,
      unchanged,
      currentRevision: existing?.revision || null,
      proposedRevision,
      architecture,
      counts: countsFor(architecture),
      changes: compareArchitectures(existing?.architecture || null, architecture)
    });
  }

  if (isArchitectureRoute && method === 'POST' && segments.length === 6 && segments[5] === 'commit') {
    const projectId = segments[2];
    const body = await readJsonBody(request);
    return withWriteLock(async () => {
      const architecture = validateArchitectureForProject(architectureFromRequestBody(body), projectId);
      const store = await readStore();
      assertProjectExists(store, projectId);
      const existing = await readArchitectureRecord(ARTIFACTS_DIR, projectId);
      const requestId = normalizeRequestId(body.requestId);
      const source = normalizeSource(body.source, 'web-ai');
      const proposedRevision = architectureRevision(architecture);
      const fingerprint = proposedRevision;

      const applied = requestId && existing
        ? existing.appliedRequests.find((item) => item.requestId === requestId)
        : null;
      if (applied) {
        if (applied.fingerprint !== fingerprint) {
          throw apiError(409, '同じrequest_idが別の概念図更新に使用されています。', [requestId]);
        }
        return sendJson(response, 200, {
          applied: false,
          replayed: true,
          unchanged: existing.revision === proposedRevision,
          projectId,
          architecture: existing.architecture,
          meta: architectureMeta(projectId, existing)
        }, {
          'X-Idempotent-Replay': 'true',
          ETag: `"${existing.revision}"`
        });
      }

      if (Object.prototype.hasOwnProperty.call(body, 'expectedRevision')) {
        const expectedRevision = cleanString(body.expectedRevision);
        const currentRevision = existing?.revision || '';
        if (expectedRevision !== currentRevision) {
          throw apiError(409, '概念図がプレビュー後に更新されています。もう一度内容を確認してください。', [
            `expectedRevision: ${expectedRevision || '(none)'}`,
            `currentRevision: ${currentRevision || '(none)'}`
          ]);
        }
      }

      const unchanged = existing?.revision === proposedRevision;
      const record = unchanged
        ? { ...existing, appliedRequests: [...existing.appliedRequests] }
        : makeArchitectureRecord(projectId, architecture, {
          source,
          appliedRequests: existing?.appliedRequests || []
        });
      if (requestId) {
        recordArchitectureRequest(record, {
          requestId,
          fingerprint,
          revision: proposedRevision,
          source,
          appliedAt: nowIso()
        });
      }
      if (!unchanged || requestId) await writeArchitectureRecordAtomic(ARTIFACTS_DIR, record);
      return sendJson(response, existing ? 200 : 201, {
        applied: !unchanged,
        replayed: false,
        unchanged,
        projectId,
        architecture: record.architecture,
        meta: architectureMeta(projectId, record)
      }, {
        ETag: `"${record.revision}"`,
        'X-Architecture-Revision': record.revision
      });
    });
  }

  if (method === 'GET' && segments.length === 3 && segments[1] === 'projects') {
    const store = await readStore();
    const project = store.projects.find((item) => item.projectId === segments[2]);
    if (!project) throw apiError(404, '指定されたプロジェクトが見つかりません。');
    return sendJson(response, 200, project);
  }

  if (method === 'POST' && url.pathname === '/api/projects') {
    const body = await readJsonBody(request);
    return withWriteLock(async () => {
      const store = await readStore();
      const draft = { ...body };
      if (!cleanString(draft.projectId)) draft.projectId = generateProjectId(draft.name);
      const normalized = validateProjectInput(draft);
      if (store.projects.some((item) => item.projectId === normalized.projectId)) {
        throw apiError(409, 'project_idが既に登録されています。', [normalized.projectId], 'PROJECT_ID_CONFLICT');
      }
      assertRepositoryUrlAvailable(store, normalized);
      const project = createProject(normalized, { source: normalizeSource(body.source) });
      store.projects.push(project);
      await writeStoreAtomic(store);
      return sendJson(response, 201, project);
    });
  }

  if (method === 'PUT' && segments.length === 3 && segments[1] === 'projects') {
    const body = await readJsonBody(request);
    return withWriteLock(async () => {
      const store = await readStore();
      const index = store.projects.findIndex((item) => item.projectId === segments[2]);
      if (index < 0) throw apiError(404, '指定されたプロジェクトが見つかりません。');
      if (body.projectId && body.projectId !== segments[2]) {
        throw apiError(400, 'プロジェクトIDは変更できません。');
      }
      const updated = updateProject(store.projects[index], body, '', {
        source: normalizeSource(body.source)
      });
      store.projects[index] = updated;
      await writeStoreAtomic(store);
      return sendJson(response, 200, updated);
    });
  }

  if (method === 'DELETE' && url.pathname === '/api/sample-projects') {
    return withWriteLock(async () => {
      const store = await readStore();
      const before = store.projects.length;
      const deletedProjectIds = store.projects.filter((item) => item.isSample === true).map((item) => item.projectId);
      const artifactRemoval = await stageProjectArtifactRemovals(deletedProjectIds);
      store.projects = store.projects.filter((item) => item.isSample !== true);
      try {
        await writeStoreAtomic(store);
      } catch (error) {
        await artifactRemoval.rollback();
        throw error;
      }
      try {
        await artifactRemoval.commit();
      } catch (error) {
        console.error('削除済みサンプルの概念図退避データを消去できませんでした。', error);
      }
      return sendJson(response, 200, { deleted: before - store.projects.length });
    });
  }

  if (method === 'DELETE' && segments.length === 3 && segments[1] === 'projects') {
    return withWriteLock(async () => {
      const store = await readStore();
      const index = store.projects.findIndex((item) => item.projectId === segments[2]);
      if (index < 0) throw apiError(404, '指定されたプロジェクトが見つかりません。');
      const artifactRemoval = await stageProjectArtifactRemovals([segments[2]]);
      store.projects.splice(index, 1);
      try {
        await writeStoreAtomic(store);
      } catch (error) {
        await artifactRemoval.rollback();
        throw error;
      }
      try {
        await artifactRemoval.commit();
      } catch (error) {
        console.error('削除済みプロジェクトの概念図退避データを消去できませんでした。', error);
      }
      return sendJson(response, 200, { deleted: true });
    });
  }

  if (method === 'POST' && url.pathname === '/api/import/preview') {
    const body = await readJsonBody(request);
    const parsed = validateAiPayload(extractAiJson(body.text));
    const store = await readStore();
    const existing = store.projects.find((item) => item.projectId === parsed.project.projectId);
    if (parsed.mode === 'create' && existing) {
      throw apiError(409, 'project_idが既に登録されています。', [parsed.project.projectId], 'PROJECT_ID_CONFLICT');
    }
    if (parsed.mode === 'create') assertRepositoryUrlAvailable(store, parsed.project);
    if (parsed.mode === 'update' && !existing) {
      throw apiError(404, '更新対象のproject_idが存在しません。', [parsed.project.projectId]);
    }
    if (body.expectedMode && body.expectedMode !== parsed.mode) {
      throw apiError(400, `この画面ではmodeが${body.expectedMode}のデータを貼り付けてください。`);
    }
    const previewProject = parsed.mode === 'create'
      ? createProject(parsed.project, {
        updatedAt: parsed.project.updatedAt,
        source: normalizeSource(body.source)
      })
      : { ...existing, ...parsed.project, projectId: existing.projectId, createdAt: existing.createdAt, history: existing.history };
    return sendJson(response, 200, {
      mode: parsed.mode,
      project: previewProject,
      changes: compareProjects(existing || null, previewProject)
    });
  }

  if (method === 'POST' && url.pathname === '/api/import/commit') {
    const body = await readJsonBody(request);
    return withWriteLock(async () => {
      const parsed = validateAiPayload(extractAiJson(body.text));
      const store = await readStore();
      const requestId = normalizeRequestId(body.requestId);
      const source = normalizeSource(body.source, 'web-ai');
      const fingerprint = projectPayloadFingerprint(parsed);
      const applied = findAppliedRequest(store, requestId);
      if (applied) {
        if (applied.fingerprint !== fingerprint || applied.projectId !== parsed.project.projectId) {
          throw apiError(409, '同じrequest_idが別の更新に使用されています。', [requestId], 'REQUEST_ID_CONFLICT');
        }
        const replayed = store.projects.find((item) => item.projectId === applied.projectId);
        if (!replayed) {
          throw apiError(
            409,
            'request_idに対応するプロジェクトが現在のデータに存在しません。',
            [requestId],
            'REQUEST_REPLAY_MISSING'
          );
        }
        return sendJson(response, 200, replayed, { 'X-Idempotent-Replay': 'true' });
      }
      const index = store.projects.findIndex((item) => item.projectId === parsed.project.projectId);
      if (parsed.mode === 'create') {
        if (index >= 0) throw apiError(409, 'project_idが既に登録されています。', [], 'PROJECT_ID_CONFLICT');
        assertRepositoryUrlAvailable(store, parsed.project);
        const created = createProject(parsed.project, {
          updatedAt: parsed.project.updatedAt,
          source
        });
        store.projects.push(created);
        if (requestId) {
          recordAppliedRequest(store, {
            requestId,
            fingerprint,
            projectId: created.projectId,
            source,
            appliedAt: nowIso()
          });
        }
        await writeStoreAtomic(store);
        return sendJson(response, 201, created);
      }
      if (index < 0) throw apiError(404, '更新対象のproject_idが存在しません。');
      const updated = updateProject(store.projects[index], parsed.project, parsed.project.updatedAt, {
        source,
        requestId
      });
      store.projects[index] = updated;
      if (requestId) {
        recordAppliedRequest(store, {
          requestId,
          fingerprint,
          projectId: updated.projectId,
          source,
          appliedAt: nowIso()
        });
      }
      await writeStoreAtomic(store);
      return sendJson(response, 200, updated);
    });
  }

  if (method === 'POST' && url.pathname === '/api/backup/preview') {
    const body = await readJsonBody(request);
    const backup = validateBackup(body.data);
    const store = await readStore();
    const existingIds = new Set(store.projects.map((item) => item.projectId));
    const conflicts = backup.store.projects.filter((item) => existingIds.has(item.projectId)).map((item) => item.projectId);
    const existingArchitectures = await listArchitectureRecords(ARTIFACTS_DIR, store.projects.map((item) => item.projectId));
    const existingArchitectureIds = new Set(existingArchitectures.map((record) => record.projectId));
    const architectureConflicts = backup.architectures
      .map((architecture) => architecture.project.project_id)
      .filter((projectId) => existingArchitectureIds.has(projectId));
    return sendJson(response, 200, {
      backupSchemaVersion: backup.sourceSchemaVersion,
      projectCount: backup.store.projects.length,
      currentCount: store.projects.length,
      newCount: backup.store.projects.length - conflicts.length,
      updateCount: conflicts.length,
      conflicts,
      architectureCount: backup.architectures.length,
      currentArchitectureCount: existingArchitectures.length,
      newArchitectureCount: backup.architectures.length - architectureConflicts.length,
      updateArchitectureCount: architectureConflicts.length,
      architectureConflicts
    });
  }

  if (method === 'POST' && url.pathname === '/api/backup/commit') {
    const body = await readJsonBody(request);
    if (!['replace', 'merge'].includes(body.strategy)) {
      throw apiError(400, '取り込み方法を選択してください。');
    }
    const backup = validateBackup(body.data);
    return withWriteLock(async () => {
      const store = await readStore();
      let targetStore;
      if (body.strategy === 'replace') targetStore = backup.store;
      else {
        const map = new Map(store.projects.map((item) => [item.projectId, item]));
        backup.store.projects.forEach((item) => map.set(item.projectId, item));
        targetStore = {
          schemaVersion: 1,
          projects: [...map.values()],
          ...(Array.isArray(store.appliedRequests) ? { appliedRequests: store.appliedRequests } : {})
        };
      }
      const artifactRecords = await backupArtifactRecords(store, backup, body.strategy);
      const artifactReplacement = await stageArtifactReplacement(artifactRecords);
      try {
        await writeStoreAtomic(targetStore);
      } catch (error) {
        await artifactReplacement.rollback();
        throw error;
      }
      try {
        await artifactReplacement.commit();
      } catch (error) {
        console.error('バックアップ適用前の概念図退避データを消去できませんでした。', error);
      }
      return sendJson(response, 200, {
        projectCount: targetStore.projects.length,
        architectureCount: artifactRecords.length,
        strategy: body.strategy,
        backupSchemaVersion: backup.sourceSchemaVersion
      });
    });
  }

  throw apiError(404, 'APIが見つかりません。');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function serveStatic(request, response, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw apiError(400, 'URLの形式が正しくありません。');
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
    throw apiError(403, 'アクセスできないパスです。');
  }
  let content;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw apiError(404, 'ページが見つかりません。');
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  if (request.method === 'HEAD') response.end();
  else response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (['GET', 'HEAD'].includes(request.method)) await serveStatic(request, response, url);
    else throw apiError(405, 'この操作は許可されていません。');
  } catch (error) {
    if (!response.headersSent) sendError(response, error);
    else response.end();
  }
});

async function start() {
  await ensureDataFile();
  server.listen(PORT, HOST, () => {
    const localUrl = `http://localhost:${PORT}`;
    console.log(`プロジェクト管理台帳を起動しました: ${localUrl}`);
    console.log(`LAN共有時は http://このPCのIPアドレス:${PORT} を開いてください。`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', localUrl], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
  });
}

start().catch((error) => {
  console.error('起動に失敗しました。', error);
  process.exit(1);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { stableStringify } = require('../lib/architecture-artifacts');

let temporaryDirectory;
let dataFile;
let port;
let baseUrl;
let child;

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close(() => resolve(selected));
    });
  });
}

async function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバー起動がタイムアウトしました。')), 5000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`サーバーが終了しました: ${code}`));
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('起動しました')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

async function request(urlPath, options = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

function architecturePayload(projectId, name, variant = 'v1') {
  return {
    schema_version: 1,
    kind: 'architecture-graph',
    document: {
      id: `${projectId}-architecture`,
      title: `${name} 概念図`,
      summary: `architecture ${variant}`,
      generated_at: '2026-08-06T10:00:00.000Z'
    },
    project: {
      project_id: projectId,
      name,
      analyzed_at: '2026-08-06T10:00:00.000Z'
    },
    groups: [{ id: 'application', name: 'Application', color: '#2563EB' }],
    components: [{
      id: 'web-app',
      name: 'Web App',
      group: 'application',
      type: 'application',
      role: variant,
      responsibilities: ['画面を提供する'],
      technologies: ['JavaScript'],
      inputs: ['HTTP request'],
      outputs: ['HTML'],
      files: ['public/index.html']
    }],
    edges: [],
    flows: []
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
}

function legacyArchitectureRevision(architecture) {
  return crypto.createHash('sha256').update(stableStringify(architecture)).digest('hex');
}

test.before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-test-'));
  dataFile = path.join(temporaryDirectory, 'projects.json');
  await fs.writeFile(dataFile, JSON.stringify({ schemaVersion: 1, projects: [] }));
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await startServer();
});

test.after(async () => {
  await stopServer();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('静的画面を配信する', async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /開発プロジェクト台帳/);
  assert.match(html, /CLI・Codex連携/);

  const scriptResponse = await fetch(`${baseUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  const script = await scriptResponse.text();
  assert.match(script, /data-copy-project-id/);
  assert.match(script, /プロジェクトIDをコピーしました。/);
});

test('ヘルスチェックとCLIメタデータを返す', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.service, 'local-project-manager');
  assert.equal(health.data.status, 'ok');

  const meta = await request('/api/meta');
  assert.equal(meta.response.status, 200);
  assert.equal(meta.data.triggerPhrases.apply, '進捗に反映');
  assert.ok(meta.data.supportedSources.includes('codex-skill'));
});

test('不正な進捗をサーバー側で拒否する', async () => {
  const { response, data } = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '不正', status: 'development', progress: 101 })
  });
  assert.equal(response.status, 400);
  assert.match(data.error, /progress/);

  const invalidAdminUrl = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'invalid-admin-url',
      name: '不正な管理URL',
      adminUrl: 'javascript:alert(1)',
      status: 'development',
      progress: 10
    })
  });
  assert.equal(invalidAdminUrl.response.status, 400);
  assert.match(invalidAdminUrl.data.error, /管理者サイトURL/);
});

test('手動登録・重複拒否・手動更新・履歴保存を行う', async () => {
  const project = {
    projectId: 'manual-app',
    name: '手動登録アプリ',
    appUrl: 'http://localhost:5000',
    adminUrl: 'http://localhost:5000/admin',
    repositoryUrl: '',
    developmentUrl: '',
    status: 'development',
    progress: 40,
    owner: 'テスト担当',
    tags: ['Webアプリ'],
    summary: '実装中',
    currentTasks: ['一覧'],
    nextTasks: ['テスト'],
    blockers: []
  };
  const created = await request('/api/projects', { method: 'POST', body: JSON.stringify(project) });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.adminUrl, 'http://localhost:5000/admin');

  const duplicate = await request('/api/projects', { method: 'POST', body: JSON.stringify(project) });
  assert.equal(duplicate.response.status, 409);

  const updated = await request('/api/projects/manual-app', {
    method: 'PUT',
    body: JSON.stringify({ status: 'testing', progress: 70, summary: 'テスト中' })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.progress, 70);
  assert.equal(updated.data.history.length, 1);
  assert.equal(updated.data.history[0].progressBefore, 40);
});

test('AI形式を確認してから新規登録する', async () => {
  const payload = {
    schema_version: 1,
    mode: 'create',
    project_id: 'ai-created',
    name: 'AI登録アプリ',
    app_url: 'http://localhost:6000',
    admin_url: 'http://localhost:6000/admin',
    repository_url: '',
    development_url: '',
    status: 'planning',
    progress: 20,
    owner: '',
    tags: ['AI'],
    summary: '設計中',
    current_tasks: ['要件整理'],
    next_tasks: ['実装'],
    blockers: [],
    updated_at: '2026-07-22T12:00:00+09:00'
  };
  const text = `説明文です。\n\`\`\`project-status\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const preview = await request('/api/import/preview', { method: 'POST', body: JSON.stringify({ text }) });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.mode, 'create');
  assert.equal(preview.data.project.projectId, 'ai-created');
  assert.equal(preview.data.project.adminUrl, 'http://localhost:6000/admin');

  const commit = await request('/api/import/commit', { method: 'POST', body: JSON.stringify({ text }) });
  assert.equal(commit.response.status, 201);
  assert.equal(commit.data.progress, 20);
  assert.equal(commit.data.createdSource, 'web-ai');

  const legacyPayload = { ...payload, project_id: 'legacy-json-preview' };
  delete legacyPayload.admin_url;
  const legacyPreview = await request('/api/import/preview', {
    method: 'POST',
    body: JSON.stringify({ text: JSON.stringify(legacyPayload) })
  });
  assert.equal(legacyPreview.response.status, 200);
  assert.equal(legacyPreview.data.project.adminUrl, '');
});

test('AI更新の差分を表示できるデータを返し、履歴を残す', async () => {
  const payload = {
    schema_version: 1,
    mode: 'update',
    project_id: 'ai-created',
    name: 'AI登録アプリ',
    app_url: 'http://localhost:6000',
    admin_url: 'http://localhost:6000/control',
    repository_url: '',
    development_url: '',
    status: 'testing',
    progress: 82,
    owner: 'AI担当',
    tags: ['AI', 'テスト'],
    summary: '動作テスト中',
    current_tasks: ['エラー確認'],
    next_tasks: ['公開'],
    blockers: [],
    updated_at: '2026-07-22T13:00:00+09:00'
  };
  const text = JSON.stringify(payload);
  const preview = await request('/api/import/preview', { method: 'POST', body: JSON.stringify({ text }) });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.changes.find((item) => item.key === 'progress').changed, true);
  assert.equal(preview.data.changes.find((item) => item.key === 'adminUrl').changed, true);

  const requestId = 'codex-test-update-1';
  const commit = await request('/api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ text, source: 'codex-skill', requestId })
  });
  assert.equal(commit.response.status, 200);
  assert.equal(commit.data.progress, 82);
  assert.equal(commit.data.history.length, 1);
  assert.equal(commit.data.history[0].source, 'codex-skill');
  assert.equal(commit.data.history[0].requestId, requestId);
  assert.equal(commit.data.lastUpdateSource, 'codex-skill');

  const replay = await request('/api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ text, source: 'codex-skill', requestId })
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.response.headers.get('x-idempotent-replay'), 'true');
  assert.equal(replay.data.history.length, 1);

  const conflictingPayload = { ...payload, progress: 83 };
  const conflict = await request('/api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ text: JSON.stringify(conflictingPayload), source: 'codex-skill', requestId })
  });
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.data.error, /request_id/);
});

test('AI入力の具体的なエラーを返す', async () => {
  const missing = await request('/api/import/preview', { method: 'POST', body: JSON.stringify({ text: '説明だけです' }) });
  assert.equal(missing.response.status, 400);
  assert.match(missing.data.error, /JSONが見つかりません/);

  const invalid = await request('/api/import/preview', { method: 'POST', body: JSON.stringify({ text: '{ invalid }' }) });
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.data.error, /構文/);
});

test('バックアップを書き出し、内容確認後に再取り込みできる', async () => {
  const exportedResponse = await fetch(`${baseUrl}/api/export`);
  assert.equal(exportedResponse.status, 200);
  assert.match(exportedResponse.headers.get('content-disposition'), /project-manager-backup-/);
  const backup = await exportedResponse.json();
  assert.equal(backup.projects.find((item) => item.projectId === 'ai-created').adminUrl, 'http://localhost:6000/control');

  const preview = await request('/api/backup/preview', {
    method: 'POST',
    body: JSON.stringify({ data: backup })
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.projectCount, 2);

  const commit = await request('/api/backup/commit', {
    method: 'POST',
    body: JSON.stringify({ data: backup, strategy: 'replace' })
  });
  assert.equal(commit.response.status, 200);
  assert.equal(commit.data.projectCount, 2);
});

test('プロジェクト別概念図をプレビューし、revision付きで原子的に保存する', async () => {
  const missing = await request('/api/projects/ai-created/artifacts/architecture/meta');
  assert.equal(missing.response.status, 200);
  assert.equal(missing.data.state, 'missing');
  assert.equal(missing.data.hasValidDocument, false);
  assert.equal(missing.data.revision, null);

  const mismatch = architecturePayload('manual-app', '手動登録アプリ');
  const rejected = await request('/api/projects/ai-created/artifacts/architecture/preview', {
    method: 'POST',
    body: JSON.stringify({ data: mismatch })
  });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.data.error, /project_id/);

  const architecture = architecturePayload('ai-created', 'AI登録アプリ');
  const preview = await request('/api/projects/ai-created/artifacts/architecture/preview', {
    method: 'POST',
    body: JSON.stringify({ data: architecture })
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.mode, 'create');
  assert.equal(preview.data.changed, true);
  assert.equal(preview.data.currentRevision, null);
  assert.match(preview.data.proposedRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.data.counts, { groups: 1, components: 1, edges: 0, flows: 0 });

  const committed = await request('/api/projects/ai-created/artifacts/architecture/commit', {
    method: 'POST',
    body: JSON.stringify({
      data: architecture,
      source: 'codex-skill',
      requestId: 'architecture-create-1',
      expectedRevision: null
    })
  });
  assert.equal(committed.response.status, 201);
  assert.equal(committed.data.applied, true);
  assert.equal(committed.data.replayed, false);
  assert.equal(committed.data.meta.state, 'ready');
  assert.equal(committed.data.meta.source, 'codex-skill');
  assert.equal(committed.response.headers.get('etag'), `"${preview.data.proposedRevision}"`);

  const envelopeFilename = path.join(path.dirname(dataFile), 'artifacts', 'ai-created', 'architecture.json');
  const envelope = JSON.parse(await fs.readFile(envelopeFilename, 'utf8'));
  assert.equal(envelope.storageSchemaVersion, 1);
  assert.equal(envelope.projectId, 'ai-created');
  assert.equal(envelope.revision, preview.data.proposedRevision);
  assert.equal(envelope.appliedRequests.length, 1);

  const loaded = await request('/api/projects/ai-created/artifacts/architecture');
  assert.equal(loaded.response.status, 200);
  assert.deepEqual(loaded.data.architecture, architecture);
  assert.equal(loaded.data.meta.revision, preview.data.proposedRevision);

  const exported = await request('/api/projects/ai-created/artifacts/architecture/export');
  assert.equal(exported.response.status, 200);
  assert.deepEqual(exported.data, architecture);
  assert.match(exported.response.headers.get('content-disposition'), /ai-created-architecture\.json/);
});

test('architecture revisions ignore analysis timestamps but retain them on meaningful updates', async () => {
  const project = {
    projectId: 'architecture-revision-semantics',
    name: 'Architecture revision semantics',
    status: 'development',
    progress: 25,
    tags: [],
    currentTasks: [],
    nextTasks: [],
    blockers: []
  };
  const created = await request('/api/projects', { method: 'POST', body: JSON.stringify(project) });
  assert.equal(created.response.status, 201);

  const original = architecturePayload(project.projectId, project.name);
  const initialCommit = await request(`/api/projects/${project.projectId}/artifacts/architecture/commit`, {
    method: 'POST',
    body: JSON.stringify({ data: original, requestId: 'revision-semantics-create' })
  });
  assert.equal(initialCommit.response.status, 201);
  const initialRevision = initialCommit.data.meta.revision;

  const timestampOnly = JSON.parse(JSON.stringify(original));
  timestampOnly.document.generated_at = '2026-08-06T11:00:00.000Z';
  timestampOnly.project.analyzed_at = '2026-08-06T11:00:00.000Z';
  const preview = await request(`/api/projects/${project.projectId}/artifacts/architecture/preview`, {
    method: 'POST',
    body: JSON.stringify({ data: timestampOnly })
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.currentRevision, initialRevision);
  assert.equal(preview.data.proposedRevision, initialRevision);
  assert.equal(preview.data.changed, false);
  assert.equal(preview.data.unchanged, true);
  assert.equal(preview.data.changes.documentChanged, false);
  assert.equal(preview.data.changes.projectChanged, false);

  const meaningfulUpdate = JSON.parse(JSON.stringify(timestampOnly));
  meaningfulUpdate.components[0].role = 'v2';
  const update = await request(`/api/projects/${project.projectId}/artifacts/architecture/commit`, {
    method: 'POST',
    body: JSON.stringify({
      data: meaningfulUpdate,
      requestId: 'revision-semantics-update',
      expectedRevision: initialRevision
    })
  });
  assert.equal(update.response.status, 200);
  assert.equal(update.data.applied, true);
  assert.notEqual(update.data.meta.revision, initialRevision);

  const loaded = await request(`/api/projects/${project.projectId}/artifacts/architecture`);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.architecture.document.generated_at, timestampOnly.document.generated_at);
  assert.equal(loaded.data.architecture.project.analyzed_at, timestampOnly.project.analyzed_at);
  const exported = await request(`/api/projects/${project.projectId}/artifacts/architecture/export`);
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.document.generated_at, timestampOnly.document.generated_at);
  assert.equal(exported.data.project.analyzed_at, timestampOnly.project.analyzed_at);

  const deleted = await request(`/api/projects/${project.projectId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
});

test('storage schema v1 accepts and safely migrates legacy full-document revisions', async () => {
  const project = {
    projectId: 'architecture-legacy-revision',
    name: 'Architecture legacy revision',
    status: 'development',
    progress: 25,
    tags: [],
    currentTasks: [],
    nextTasks: [],
    blockers: []
  };
  const created = await request('/api/projects', { method: 'POST', body: JSON.stringify(project) });
  assert.equal(created.response.status, 201);

  const architecture = architecturePayload(project.projectId, project.name);
  const semanticPreview = await request(`/api/projects/${project.projectId}/artifacts/architecture/preview`, {
    method: 'POST',
    body: JSON.stringify({ data: architecture })
  });
  assert.equal(semanticPreview.response.status, 200);
  const semanticRevision = semanticPreview.data.proposedRevision;
  const legacyRevision = legacyArchitectureRevision(architecture);
  assert.notEqual(legacyRevision, semanticRevision);

  const artifactDirectory = path.join(path.dirname(dataFile), 'artifacts', project.projectId);
  const envelopeFilename = path.join(artifactDirectory, 'architecture.json');
  await fs.mkdir(artifactDirectory, { recursive: true });
  await fs.writeFile(envelopeFilename, `${JSON.stringify({
    storageSchemaVersion: 1,
    projectId: project.projectId,
    revision: legacyRevision,
    updatedAt: '2026-08-06T10:00:00.000Z',
    source: 'codex-skill',
    appliedRequests: [
      {
        requestId: 'legacy-current-request',
        fingerprint: legacyRevision,
        revision: legacyRevision,
        source: 'codex-skill',
        appliedAt: '2026-08-06T10:00:00.000Z'
      },
      {
        requestId: 'legacy-unrelated-request',
        fingerprint: 'a'.repeat(64),
        revision: 'b'.repeat(64),
        source: 'codex-skill',
        appliedAt: '2026-08-06T09:00:00.000Z'
      }
    ],
    architecture
  }, null, 2)}\n`, 'utf8');

  const loaded = await request(`/api/projects/${project.projectId}/artifacts/architecture`);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.meta.revision, semanticRevision);
  assert.equal(loaded.response.headers.get('etag'), `"${semanticRevision}"`);

  const replay = await request(`/api/projects/${project.projectId}/artifacts/architecture/commit`, {
    method: 'POST',
    body: JSON.stringify({ data: architecture, requestId: 'legacy-current-request' })
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.response.headers.get('x-idempotent-replay'), 'true');
  assert.equal(replay.data.replayed, true);

  const persisted = await request(`/api/projects/${project.projectId}/artifacts/architecture/commit`, {
    method: 'POST',
    body: JSON.stringify({
      data: architecture,
      requestId: 'legacy-migration-persist',
      expectedRevision: semanticRevision
    })
  });
  assert.equal(persisted.response.status, 200);
  assert.equal(persisted.data.unchanged, true);

  const migratedEnvelope = JSON.parse(await fs.readFile(envelopeFilename, 'utf8'));
  assert.equal(migratedEnvelope.revision, semanticRevision);
  const migratedRequest = migratedEnvelope.appliedRequests.find((item) => item.requestId === 'legacy-current-request');
  assert.equal(migratedRequest.fingerprint, semanticRevision);
  assert.equal(migratedRequest.revision, semanticRevision);
  const unrelatedRequest = migratedEnvelope.appliedRequests.find((item) => item.requestId === 'legacy-unrelated-request');
  assert.equal(unrelatedRequest.fingerprint, 'a'.repeat(64));
  assert.equal(unrelatedRequest.revision, 'b'.repeat(64));

  const deleted = await request(`/api/projects/${project.projectId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
});

test('概念図commitはrequestId再送とexpectedRevision競合を安全に処理する', async () => {
  const original = architecturePayload('ai-created', 'AI登録アプリ');
  const reorderedPreview = await request('/api/projects/ai-created/artifacts/architecture/preview', {
    method: 'POST',
    body: JSON.stringify({ data: reverseObjectKeys(original) })
  });
  assert.equal(reorderedPreview.response.status, 200);
  assert.equal(reorderedPreview.data.unchanged, true);

  const replay = await request('/api/projects/ai-created/artifacts/architecture/commit', {
    method: 'POST',
    body: JSON.stringify({
      data: original,
      source: 'codex-skill',
      requestId: 'architecture-create-1',
      expectedRevision: null
    })
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.response.headers.get('x-idempotent-replay'), 'true');
  assert.equal(replay.data.replayed, true);

  const firstMeta = await request('/api/projects/ai-created/artifacts/architecture/meta');
  const updated = architecturePayload('ai-created', 'AI登録アプリ', 'v2');
  const updatePreview = await request('/api/projects/ai-created/artifacts/architecture/preview', {
    method: 'POST',
    body: JSON.stringify({ text: `\`\`\`architecture-json\n${JSON.stringify(updated)}\n\`\`\`` })
  });
  assert.equal(updatePreview.response.status, 200);
  assert.equal(updatePreview.data.mode, 'update');
  assert.equal(updatePreview.data.changes.components.changed, 1);

  const updateCommit = await request('/api/projects/ai-created/artifacts/architecture/commit', {
    method: 'POST',
    body: JSON.stringify({
      data: updated,
      source: 'codex-skill',
      requestId: 'architecture-update-2',
      expectedRevision: firstMeta.data.revision
    })
  });
  assert.equal(updateCommit.response.status, 200);
  assert.equal(updateCommit.data.applied, true);
  assert.notEqual(updateCommit.data.meta.revision, firstMeta.data.revision);

  const stale = architecturePayload('ai-created', 'AI登録アプリ', 'v3');
  const conflict = await request('/api/projects/ai-created/artifacts/architecture/commit', {
    method: 'POST',
    body: JSON.stringify({ data: stale, requestId: 'architecture-update-3', expectedRevision: firstMeta.data.revision })
  });
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.data.error, /プレビュー後/);

  const reusedRequest = await request('/api/projects/ai-created/artifacts/architecture/commit', {
    method: 'POST',
    body: JSON.stringify({ data: stale, requestId: 'architecture-create-1' })
  });
  assert.equal(reusedRequest.response.status, 409);
  assert.match(reusedRequest.data.error, /request_id/);
});

test('バックアップv2は概念図を含み、v1 mergeとの互換性を保つ', async () => {
  const exportedResponse = await fetch(`${baseUrl}/api/export`);
  assert.equal(exportedResponse.status, 200);
  const backupV2 = await exportedResponse.json();
  assert.equal(backupV2.schemaVersion, 2);
  assert.equal(backupV2.architectures.length, 1);
  assert.equal(backupV2.architectures[0].project.project_id, 'ai-created');

  const previewV2 = await request('/api/backup/preview', {
    method: 'POST',
    body: JSON.stringify({ data: backupV2 })
  });
  assert.equal(previewV2.response.status, 200);
  assert.equal(previewV2.data.architectureCount, 1);
  assert.equal(previewV2.data.updateArchitectureCount, 1);

  const legacyV1 = { schemaVersion: 1, projects: backupV2.projects };
  const legacyCommit = await request('/api/backup/commit', {
    method: 'POST',
    body: JSON.stringify({ data: legacyV1, strategy: 'merge' })
  });
  assert.equal(legacyCommit.response.status, 200);
  assert.equal(legacyCommit.data.backupSchemaVersion, 1);
  assert.equal(legacyCommit.data.architectureCount, 1);

  const stillPresent = await request('/api/projects/ai-created/artifacts/architecture');
  assert.equal(stillPresent.response.status, 200);
  assert.equal(stillPresent.data.architecture.components[0].role, 'v2');

  const legacyReplace = await request('/api/backup/commit', {
    method: 'POST',
    body: JSON.stringify({ data: legacyV1, strategy: 'replace' })
  });
  assert.equal(legacyReplace.response.status, 200);
  assert.equal(legacyReplace.data.architectureCount, 0);
  const clearedMeta = await request('/api/projects/ai-created/artifacts/architecture/meta');
  assert.equal(clearedMeta.response.status, 200);
  assert.equal(clearedMeta.data.state, 'missing');

  const replace = await request('/api/backup/commit', {
    method: 'POST',
    body: JSON.stringify({ data: backupV2, strategy: 'replace' })
  });
  assert.equal(replace.response.status, 200);
  assert.equal(replace.data.backupSchemaVersion, 2);
  assert.equal(replace.data.architectureCount, 1);
});

test('プロジェクト削除時に対応するartifactsディレクトリも削除する', async () => {
  const project = {
    projectId: 'architecture-delete-target',
    name: '削除連動確認',
    status: 'testing',
    progress: 50,
    tags: [],
    currentTasks: [],
    nextTasks: [],
    blockers: []
  };
  const created = await request('/api/projects', { method: 'POST', body: JSON.stringify(project) });
  assert.equal(created.response.status, 201);
  const architecture = architecturePayload(project.projectId, project.name);
  const committed = await request(`/api/projects/${project.projectId}/artifacts/architecture/commit`, {
    method: 'POST',
    body: JSON.stringify({ data: architecture, requestId: 'architecture-delete-create' })
  });
  assert.equal(committed.response.status, 201);
  const artifactDirectory = path.join(path.dirname(dataFile), 'artifacts', project.projectId);
  await fs.access(path.join(artifactDirectory, 'architecture.json'));

  const deleted = await request(`/api/projects/${project.projectId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  await assert.rejects(fs.access(artifactDirectory), { code: 'ENOENT' });
});

test('再起動後もJSONデータが残る', async () => {
  await stopServer();
  await startServer();
  const listed = await request('/api/projects');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.data.projects.length, 2);
  assert.ok(listed.data.projects.some((item) => item.projectId === 'ai-created'));
  const architecture = await request('/api/projects/ai-created/artifacts/architecture');
  assert.equal(architecture.response.status, 200);
  assert.equal(architecture.data.architecture.components[0].role, 'v2');
});

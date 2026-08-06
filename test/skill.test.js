'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const SKILL_SCRIPT = path.join(
  APP_ROOT, 'plugin', 'project-progress-manager', 'skills', 'project-progress-update', 'scripts', 'update-project.mjs'
);
const ARCHITECTURE_SKILL_SCRIPT = path.join(
  APP_ROOT, 'plugin', 'project-progress-manager', 'skills', 'project-architecture-update', 'scripts', 'update-architecture.mjs'
);

let temporaryDirectory;
let dataFile;
let baseUrl;
let server;

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
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: APP_ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('スキルテスト用サーバーの起動がタイムアウトしました。')), 5000);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`スキルテスト用サーバーが終了しました: ${code}`));
    });
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('起動しました')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    server.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

function payload(projectId = 'skill-target') {
  return {
    schema_version: 1,
    mode: 'update',
    project_id: projectId,
    name: 'スキル対象',
    app_url: '',
    admin_url: '',
    repository_url: '',
    development_url: '',
    status: 'testing',
    progress: 64,
    owner: '',
    tags: ['Codex'],
    summary: 'スキル統合テスト済み',
    current_tasks: ['総合テスト'],
    next_tasks: ['公開'],
    blockers: [],
    updated_at: '2026-07-26T13:00:00.000Z'
  };
}

function architecturePayload(projectId = 'skill-target') {
  return {
    schema_version: 1,
    kind: 'architecture-graph',
    document: {
      id: `${projectId}-architecture`,
      title: 'スキル対象の概念図',
      summary: '実コード分析結果',
      generated_at: '2026-08-06T01:00:00.000Z'
    },
    project: {
      project_id: projectId,
      name: 'スキル対象',
      summary: '概念図スキル統合テスト',
      analyzed_at: '2026-08-06T01:00:00.000Z',
      source_root: '.'
    },
    groups: [{ id: 'runtime', name: 'Runtime', color: '#16A34A' }],
    components: [{
      id: 'service',
      name: 'Service',
      group: 'runtime',
      type: 'backend',
      role: 'APIを提供する',
      responsibilities: ['要求を処理する'],
      technologies: ['Node.js'],
      inputs: ['HTTP request'],
      outputs: ['JSON response'],
      files: ['server.js']
    }],
    edges: [],
    flows: [{
      id: 'request-flow',
      name: '要求処理',
      description: 'API要求を処理する',
      node_ids: ['service'],
      edge_ids: [],
      steps: [{ title: '処理', description: '要求を処理する', component_id: 'service' }]
    }]
  };
}

async function runScript(script, action, input, extraArguments = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, action, ...extraArguments], {
      cwd: temporaryDirectory,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runScriptFile(script, action, filename) {
  return runScript(script, action, '', ['--file', filename]);
}

function runSkill(action, input) {
  return runScript(SKILL_SCRIPT, action, input);
}

test.before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-skill-'));
  dataFile = path.join(temporaryDirectory, 'projects.json');
  await fs.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    projects: [{
      projectId: 'skill-target',
      name: 'スキル対象',
      appUrl: '',
      adminUrl: '',
      repositoryUrl: '',
      developmentUrl: '',
      status: 'development',
      progress: 30,
      owner: '',
      tags: ['Codex'],
      summary: '更新前',
      currentTasks: ['実装'],
      nextTasks: ['テスト'],
      blockers: [],
      createdAt: '2026-07-26T10:00:00.000Z',
      updatedAt: '2026-07-26T10:00:00.000Z',
      history: []
    }]
  }));
  await startServer();
  await fs.writeFile(path.join(temporaryDirectory, '.project-manager.json'), JSON.stringify({
    schema_version: 1,
    project_id: 'skill-target',
    manager_url: baseUrl
  }));
});

test.after(async () => {
  await stopServer();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('スキル付属スクリプトがプレビュー後にcodex-skillとして反映する', async () => {
  const text = JSON.stringify(payload());
  const filename = path.join(temporaryDirectory, '進捗.json');
  await fs.writeFile(filename, text, 'utf8');
  const preview = await runScriptFile(SKILL_SCRIPT, '--preview', filename);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).project.progress, 64);
  assert.equal(JSON.parse(preview.stdout).project.summary, 'スキル統合テスト済み');

  const applied = await runScriptFile(SKILL_SCRIPT, '--apply', filename);
  assert.equal(applied.code, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.project.lastUpdateSource, 'codex-skill');
  assert.equal(result.project.history[0].source, 'codex-skill');
  assert.match(result.requestId, /^codex-/);

  const repeated = await runScriptFile(SKILL_SCRIPT, '--apply', filename);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).applied, false);
});

test('関連付けと異なるproject_idを拒否する', async () => {
  const result = await runSkill('--preview', JSON.stringify(payload('wrong-target')));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /project_idが関連付けと一致しません/);
});

test('概念図スキルが検証・プレビュー後にcodex-skillとして反映する', async () => {
  const text = JSON.stringify(architecturePayload());
  const filename = path.join(temporaryDirectory, '概念図.json');
  await fs.writeFile(filename, text, 'utf8');
  const preview = await runScriptFile(ARCHITECTURE_SKILL_SCRIPT, '--preview', filename);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).changed, true);

  const applied = await runScriptFile(ARCHITECTURE_SKILL_SCRIPT, '--apply', filename);
  assert.equal(applied.code, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.meta.source, 'codex-skill');
  assert.match(result.requestId, /^architecture-skill-target-[a-f0-9]{32}$/);

  const envelope = JSON.parse(await fs.readFile(
    path.join(temporaryDirectory, 'artifacts', 'skill-target', 'architecture.json'),
    'utf8'
  ));
  assert.equal(envelope.architecture.document.title, 'スキル対象の概念図');

  const repeated = await runScriptFile(ARCHITECTURE_SKILL_SCRIPT, '--apply', filename);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).applied, false);
  assert.equal(JSON.parse(repeated.stdout).reason, 'no_changes');
});

test('概念図スキルが関連付け不一致と参照切れを保存前に拒否する', async () => {
  const mismatch = await runScript(
    ARCHITECTURE_SKILL_SCRIPT,
    '--preview',
    JSON.stringify(architecturePayload('wrong-target'))
  );
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /project\.project_idが関連付けと一致しません/);

  const invalid = architecturePayload();
  invalid.flows[0].node_ids = ['missing-component'];
  const brokenReference = await runScript(ARCHITECTURE_SKILL_SCRIPT, '--preview', JSON.stringify(invalid));
  assert.equal(brokenReference.code, 1);
  assert.match(brokenReference.stderr, /node_idsに不正な参照/);
});

test('両スキルが値のない--fileを拒否する', async () => {
  for (const script of [SKILL_SCRIPT, ARCHITECTURE_SKILL_SCRIPT]) {
    const result = await runScript(script, '--preview', '', ['--file']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--fileのパスを指定してください/);
  }
});

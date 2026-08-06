'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const CLI_FILE = path.join(APP_ROOT, 'bin', 'project-manager.js');
const PLUGIN_CLI_FILE = path.join(APP_ROOT, 'plugin', 'project-progress-manager', 'scripts', 'project-manager.cjs');

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
    const timer = setTimeout(() => reject(new Error('CLIテスト用サーバーの起動がタイムアウトしました。')), 5000);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLIテスト用サーバーが終了しました: ${code}`));
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

async function runCliFile(cliFile, args, { input = '', cwd = temporaryDirectory } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      cwd,
      env: { ...process.env },
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

function runCli(args, options) {
  return runCliFile(CLI_FILE, args, options);
}

function updatePayload(progress = 55) {
  return {
    schema_version: 1,
    mode: 'update',
    project_id: 'cli-target',
    name: 'CLI対象',
    app_url: '',
    admin_url: '',
    repository_url: '',
    development_url: '',
    status: 'testing',
    progress,
    owner: '',
    tags: ['CLI'],
    summary: 'CLIから更新',
    current_tasks: ['統合テスト'],
    next_tasks: ['公開'],
    blockers: [],
    updated_at: '2026-07-26T12:00:00.000Z'
  };
}

function architecturePayload(projectId = 'cli-target') {
  return {
    schema_version: 1,
    kind: 'architecture-graph',
    document: {
      id: `${projectId}-architecture`,
      title: 'CLI対象の概念図',
      summary: 'CLI統合テスト用の最小構成',
      generated_at: '2026-08-06T00:00:00.000Z'
    },
    project: {
      project_id: projectId,
      name: 'CLI対象',
      summary: 'CLI統合テスト',
      analyzed_at: '2026-08-06T00:00:00.000Z'
    },
    groups: [{ id: 'frontend', name: 'Frontend', color: '#2563EB' }],
    components: [{
      id: 'web-ui',
      name: 'Web UI',
      group: 'frontend',
      type: 'frontend',
      role: '利用者向け画面',
      responsibilities: ['概念図を表示する'],
      technologies: ['HTML'],
      inputs: ['architecture JSON'],
      outputs: ['SVG'],
      files: ['public/index.html']
    }],
    edges: [],
    flows: [{
      id: 'view-flow',
      name: '閲覧フロー',
      description: '概念図を閲覧する',
      node_ids: ['web-ui'],
      edge_ids: [],
      steps: [{ title: '表示', description: 'JSONを図へ描画する', component_id: 'web-ui' }]
    }]
  };
}

test.before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-cli-'));
  dataFile = path.join(temporaryDirectory, 'projects.json');
  await fs.writeFile(dataFile, JSON.stringify({
    schemaVersion: 1,
    projects: [{
      projectId: 'cli-target',
      name: 'CLI対象',
      appUrl: '',
      adminUrl: '',
      repositoryUrl: '',
      developmentUrl: '',
      status: 'development',
      progress: 10,
      owner: '',
      tags: ['CLI'],
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
});

test.after(async () => {
  await stopServer();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('doctorとlistを機械処理用JSONで取得する', async () => {
  const doctor = await runCli(['doctor', '--url', baseUrl, '--no-start', '--json']);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ok, true);

  const listed = await runCli(['list', '--url', baseUrl, '--no-start', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).projects[0].projectId, 'cli-target');
});

test('標準入力のJSONをプレビューしてCLIから反映する', async () => {
  const text = JSON.stringify(updatePayload());
  const preview = await runCli([
    'preview', '--stdin', '--url', baseUrl, '--no-start', '--project', 'cli-target', '--json'
  ], { input: text });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).project.progress, 55);

  const applied = await runCli([
    'apply', '--stdin', '--url', baseUrl, '--no-start', '--source', 'cli',
    '--request-id', 'cli-integration-1', '--json'
  ], { input: text });
  assert.equal(applied.code, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.project.history.length, 1);
  assert.equal(result.project.history[0].source, 'cli');

  const replay = await runCli([
    'apply', '--stdin', '--url', baseUrl, '--no-start', '--source', 'cli',
    '--request-id', 'cli-integration-1', '--force', '--json'
  ], { input: text });
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal(JSON.parse(replay.stdout).project.history.length, 1);
});

test('差分なしは更新せず、対象ID不一致は拒否する', async () => {
  const text = JSON.stringify(updatePayload());
  const unchanged = await runCli([
    'apply', '--stdin', '--url', baseUrl, '--no-start', '--json'
  ], { input: text });
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.equal(JSON.parse(unchanged.stdout).applied, false);

  const mismatch = await runCli([
    'preview', '--stdin', '--url', baseUrl, '--no-start', '--project', 'other-project', '--json'
  ], { input: text });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /対象project_idが一致しません/);
});

test('作業フォルダを登録済みプロジェクトへ関連付ける', async () => {
  const linkedDirectory = path.join(temporaryDirectory, 'linked-project');
  await fs.mkdir(linkedDirectory);
  const linked = await runCli([
    'link', 'cli-target', '--url', baseUrl, '--no-start', '--json'
  ], { cwd: linkedDirectory });
  assert.equal(linked.code, 0, linked.stderr);
  const config = JSON.parse(await fs.readFile(path.join(linkedDirectory, '.project-manager.json'), 'utf8'));
  assert.equal(config.project_id, 'cli-target');
  assert.equal(config.manager_url, baseUrl);
});

test('概念図をpreview-firstで反映しstatusとshowで確認する', async () => {
  const text = JSON.stringify(architecturePayload());
  const missing = await runCli([
    'architecture', 'status', 'cli-target', '--url', baseUrl, '--no-start', '--json'
  ]);
  assert.equal(missing.code, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).state, 'missing');

  const preview = await runCli([
    'architecture', 'preview', 'cli-target', '--stdin', '--url', baseUrl, '--no-start', '--json'
  ], { input: text });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).changed, true);

  const applied = await runCli([
    'architecture', 'apply', 'cli-target', '--stdin', '--url', baseUrl, '--no-start', '--source', 'codex-skill', '--json'
  ], { input: text });
  assert.equal(applied.code, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.match(result.requestId, /^architecture-cli-target-[a-f0-9]{32}$/);

  const ready = await runCli([
    'architecture', 'status', 'cli-target', '--url', baseUrl, '--no-start', '--json'
  ]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).state, 'ready');

  const shown = await runCli([
    'architecture', 'show', 'cli-target', '--url', baseUrl, '--no-start', '--json'
  ]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).architecture.project.project_id, 'cli-target');

  const replay = await runCli([
    'architecture', 'apply', 'cli-target', '--stdin', '--url', baseUrl, '--no-start', '--source', 'codex-skill', '--force', '--json'
  ], { input: text });
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).requestId, result.requestId);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
});

test('概念図を書き出し、関連付けと異なるIDを拒否する', async () => {
  const exportFile = path.join(temporaryDirectory, 'cli-target.architecture.json');
  const exported = await runCli([
    'architecture', 'export', 'cli-target', '--url', baseUrl, '--no-start', '--output', exportFile, '--json'
  ]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).exported, true);
  assert.equal(JSON.parse(await fs.readFile(exportFile, 'utf8')).project.project_id, 'cli-target');

  const protectedOutput = await runCli([
    'architecture', 'export', 'cli-target', '--url', baseUrl, '--no-start', '--output', exportFile, '--json'
  ]);
  assert.equal(protectedOutput.code, 1);
  assert.match(protectedOutput.stderr, /--force/);

  const linkedDirectory = path.join(temporaryDirectory, 'architecture-linked');
  await fs.mkdir(linkedDirectory);
  await fs.writeFile(path.join(linkedDirectory, '.project-manager.json'), JSON.stringify({
    schema_version: 1,
    project_id: 'cli-target',
    manager_url: baseUrl
  }));
  const mismatch = await runCli([
    'architecture', 'preview', '--project', 'other-project', '--stdin', '--url', baseUrl, '--no-start', '--json'
  ], { cwd: linkedDirectory, input: JSON.stringify(architecturePayload('other-project')) });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /関連付けと一致しません/);
});

test('配布プラグイン同梱CLIでも概念図を取得・検証できる', async () => {
  const status = await runCliFile(PLUGIN_CLI_FILE, [
    'architecture', 'status', 'cli-target', '--url', baseUrl, '--json'
  ]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'ready');

  const preview = await runCliFile(PLUGIN_CLI_FILE, [
    'architecture', 'preview', 'cli-target', '--stdin', '--url', baseUrl, '--json'
  ], { input: JSON.stringify(architecturePayload()) });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).changed, false);
});

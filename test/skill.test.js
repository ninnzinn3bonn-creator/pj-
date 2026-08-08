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
const REGISTRATION_SKILL_SCRIPT = path.join(
  APP_ROOT, 'plugin', 'project-progress-manager', 'skills', 'register-project', 'scripts', 'register-project.mjs'
);

let temporaryDirectory;
let registrationDirectory;
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

async function runRegistration(arguments_, { cwd, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REGISTRATION_SKILL_SCRIPT, ...arguments_], {
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

function registrationPayload(projectId, overrides = {}) {
  return {
    schema_version: 1,
    mode: 'create',
    project_id: projectId,
    name: '新規登録プロジェクト',
    app_url: '',
    admin_url: '',
    repository_url: `https://github.com/example/${projectId}`,
    development_url: '',
    status: 'development',
    progress: 25,
    owner: '',
    tags: ['Codex', '新規登録'],
    summary: '登録スキルの統合テスト',
    current_tasks: ['登録処理を検証する'],
    next_tasks: ['進捗を更新する'],
    blockers: [],
    updated_at: '2026-08-08T01:00:00.000Z',
    ...overrides
  };
}

async function makeRegistrationWorkspace(name) {
  const workspace = path.join(registrationDirectory, name);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

async function writeRegistrationPayload(workspace, projectId, overrides = {}, filename = 'project-status.json') {
  const payload = registrationPayload(projectId, overrides);
  const inputFile = path.join(workspace, filename);
  await fs.writeFile(inputFile, JSON.stringify(payload, null, 2), 'utf8');
  return { inputFile, payload };
}

function registrationArguments(action, workspace, inputFile, extraArguments = []) {
  return [action, '--file', inputFile, '--url', baseUrl, '--root', workspace, ...extraArguments];
}

async function fetchProject(projectId) {
  const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}`);
  const data = await response.json();
  return { response, data };
}

function parseRegistrationError(result) {
  assert.notEqual(result.code, 0, result.stdout);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.error?.code, 'string');
  assert.equal(typeof parsed.error?.message, 'string');
  return parsed.error;
}

test.before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-skill-'));
  registrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-register-skill-'));
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
  await fs.rm(registrationDirectory, { recursive: true, force: true });
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

test('新規登録スキルのpreviewは台帳と関連付けを変更しない', async () => {
  const workspace = await makeRegistrationWorkspace('preview-only');
  const { inputFile } = await writeRegistrationPayload(workspace, 'registration-preview');
  const storeBefore = await fs.readFile(dataFile, 'utf8');
  const filesBefore = await fs.readdir(workspace);

  const result = await runRegistration(
    registrationArguments('--preview', workspace, inputFile),
    { cwd: workspace }
  );

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.action, 'preview');
  assert.equal(output.managerUrl, baseUrl);
  assert.equal(output.projectId, 'registration-preview');
  assert.equal(output.preview.mode, 'create');
  assert.equal(output.preview.project.projectId, 'registration-preview');
  assert.equal(output.preview.project.createdSource, 'codex-skill');
  assert.equal(output.preview.project.lastUpdateSource, 'codex-skill');
  assert.equal(await fs.readFile(dataFile, 'utf8'), storeBefore);
  assert.deepEqual(await fs.readdir(workspace), filesBefore);
  await assert.rejects(
    fs.access(path.join(workspace, '.project-manager.json')),
    { code: 'ENOENT' }
  );
  const lookup = await fetchProject('registration-preview');
  assert.equal(lookup.response.status, 404);
});

test('新規登録スキルのapplyはcodex-skill由来で登録し正しい関連付けを作る', async () => {
  const workspace = await makeRegistrationWorkspace('apply-create');
  const { inputFile } = await writeRegistrationPayload(workspace, 'registration-apply');

  const result = await runRegistration(
    registrationArguments('--apply', workspace, inputFile),
    { cwd: workspace }
  );

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.action, 'apply');
  assert.equal(output.applied, true);
  assert.equal(output.replayed, false);
  assert.match(output.requestId, /^register-registration-apply-[a-f0-9]{32}$/);
  assert.equal(output.project.projectId, 'registration-apply');
  assert.equal(output.project.createdSource, 'codex-skill');
  assert.equal(output.project.lastUpdateSource, 'codex-skill');
  assert.equal(output.mapping.written, true);
  assert.equal(path.resolve(output.mapping.path), path.join(workspace, '.project-manager.json'));

  const stored = await fetchProject('registration-apply');
  assert.equal(stored.response.status, 200);
  assert.equal(stored.data.createdSource, 'codex-skill');
  assert.equal(stored.data.lastUpdateSource, 'codex-skill');
  const mapping = JSON.parse(await fs.readFile(path.join(workspace, '.project-manager.json'), 'utf8'));
  assert.deepEqual(mapping, {
    schema_version: 1,
    project_id: 'registration-apply',
    manager_url: baseUrl
  });

  const repeated = await runRegistration(
    registrationArguments('--apply', workspace, inputFile),
    { cwd: workspace }
  );
  assert.equal(parseRegistrationError(repeated).code, 'MAPPING_EXISTS');

  const collisionWorkspace = await makeRegistrationWorkspace('apply-id-collision');
  const collision = await writeRegistrationPayload(collisionWorkspace, 'registration-apply', {
    repository_url: 'https://github.com/example/registration-apply-collision'
  });
  const storeBefore = await fs.readFile(dataFile, 'utf8');
  const collided = await runRegistration(
    registrationArguments('--preview', collisionWorkspace, collision.inputFile),
    { cwd: collisionWorkspace }
  );
  assert.equal(parseRegistrationError(collided).code, 'PROJECT_ID_CONFLICT');
  assert.equal(await fs.readFile(dataFile, 'utf8'), storeBefore);
  await assert.rejects(
    fs.access(path.join(collisionWorkspace, '.project-manager.json')),
    { code: 'ENOENT' }
  );

  const repositoryCollisionWorkspace = await makeRegistrationWorkspace('apply-repository-collision');
  const repositoryCollision = await writeRegistrationPayload(
    repositoryCollisionWorkspace,
    'registration-repository-collision',
    { repository_url: 'https://github.com/example/registration-apply' }
  );
  const repositoryCollided = await runRegistration(
    registrationArguments('--preview', repositoryCollisionWorkspace, repositoryCollision.inputFile),
    { cwd: repositoryCollisionWorkspace }
  );
  assert.equal(parseRegistrationError(repositoryCollided).code, 'REPOSITORY_CONFLICT');
  await assert.rejects(
    fs.access(path.join(repositoryCollisionWorkspace, '.project-manager.json')),
    { code: 'ENOENT' }
  );

  const requestConflictWorkspace = await makeRegistrationWorkspace('apply-request-id-collision');
  const requestConflict = await writeRegistrationPayload(
    requestConflictWorkspace,
    'registration-request-id-collision'
  );
  const requestConflicted = await runRegistration(
    registrationArguments('--apply', requestConflictWorkspace, requestConflict.inputFile, [
      '--request-id',
      output.requestId
    ]),
    { cwd: requestConflictWorkspace }
  );
  assert.equal(parseRegistrationError(requestConflicted).code, 'REQUEST_ID_CONFLICT');
  await assert.rejects(
    fs.access(path.join(requestConflictWorkspace, '.project-manager.json')),
    { code: 'ENOENT' }
  );
});

test('新規登録スキルはmode=updateと既存の関連付けを拒否する', async () => {
  const updateWorkspace = await makeRegistrationWorkspace('update-mode');
  const update = await writeRegistrationPayload(updateWorkspace, 'registration-update-mode', { mode: 'update' });
  const updateResult = await runRegistration(
    registrationArguments('--preview', updateWorkspace, update.inputFile),
    { cwd: updateWorkspace }
  );
  const updateError = parseRegistrationError(updateResult);
  assert.equal(updateError.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(updateError.errors), /mode.*create/i);

  const mappedWorkspace = await makeRegistrationWorkspace('already-mapped');
  const mappingFile = path.join(mappedWorkspace, '.project-manager.json');
  const existingMapping = JSON.stringify({
    schema_version: 1,
    project_id: 'skill-target',
    manager_url: baseUrl
  });
  await fs.writeFile(mappingFile, existingMapping, 'utf8');
  const mapped = await writeRegistrationPayload(mappedWorkspace, 'registration-mapped');
  const storeBefore = await fs.readFile(dataFile, 'utf8');
  const mappedResult = await runRegistration(
    registrationArguments('--preview', mappedWorkspace, mapped.inputFile),
    { cwd: mappedWorkspace }
  );
  assert.equal(parseRegistrationError(mappedResult).code, 'MAPPING_EXISTS');
  assert.equal(await fs.readFile(mappingFile, 'utf8'), existingMapping);
  assert.equal(await fs.readFile(dataFile, 'utf8'), storeBefore);
  const lookup = await fetchProject('registration-mapped');
  assert.equal(lookup.response.status, 404);
});

test('新規登録スキルは不正なID・URL・値のない--fileを拒否する', async () => {
  const storeBefore = await fs.readFile(dataFile, 'utf8');
  const invalidIdWorkspace = await makeRegistrationWorkspace('invalid-id');
  const invalidId = await writeRegistrationPayload(invalidIdWorkspace, 'invalid-id', {
    project_id: '日本語_ID'
  });
  const invalidIdResult = await runRegistration(
    registrationArguments('--preview', invalidIdWorkspace, invalidId.inputFile),
    { cwd: invalidIdWorkspace }
  );
  const invalidIdError = parseRegistrationError(invalidIdResult);
  assert.equal(invalidIdError.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(invalidIdError.errors), /project_id|プロジェクトID/);

  const invalidUrlWorkspace = await makeRegistrationWorkspace('invalid-url');
  const invalidUrl = await writeRegistrationPayload(invalidUrlWorkspace, 'registration-invalid-url');
  const invalidUrlResult = await runRegistration([
    '--preview', '--file', invalidUrl.inputFile, '--url', 'ftp://127.0.0.1:4170', '--root', invalidUrlWorkspace
  ], { cwd: invalidUrlWorkspace });
  const invalidUrlError = parseRegistrationError(invalidUrlResult);
  assert.match(invalidUrlError.message, /URL|http/i);

  const missingFileWorkspace = await makeRegistrationWorkspace('missing-file-value');
  const missingFileResult = await runRegistration([
    '--preview', '--file', '--url', baseUrl, '--root', missingFileWorkspace
  ], { cwd: missingFileWorkspace });
  const missingFileError = parseRegistrationError(missingFileResult);
  assert.equal(missingFileError.code, 'ARGUMENT_ERROR');
  assert.match(missingFileError.message, /--file/);

  const helpResult = await runRegistration(['--help'], { cwd: missingFileWorkspace });
  assert.equal(helpResult.code, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /Usage:/);
  assert.match(helpResult.stdout, /--preview/);
  assert.match(helpResult.stdout, /--apply/);
  assert.equal(await fs.readFile(dataFile, 'utf8'), storeBefore);
  for (const workspace of [invalidIdWorkspace, invalidUrlWorkspace, missingFileWorkspace]) {
    await assert.rejects(
      fs.access(path.join(workspace, '.project-manager.json')),
      { code: 'ENOENT' }
    );
  }
});

test('新規登録スキルは日本語の作業パスとUTF-8 JSONを扱う', async () => {
  const workspace = await makeRegistrationWorkspace('日本語プロジェクト');
  const { inputFile } = await writeRegistrationPayload(
    workspace,
    'registration-japanese-path',
    {
      name: '日本語パスのプロジェクト',
      summary: '日本語の説明をUTF-8のまま登録する',
      current_tasks: ['日本語ファイルを検証中'],
      next_tasks: ['別のパソコンで確認する']
    },
    '新規登録データ.json'
  );

  const preview = await runRegistration(
    registrationArguments('--preview', workspace, inputFile),
    { cwd: workspace }
  );
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).preview.project.name, '日本語パスのプロジェクト');

  const applied = await runRegistration(
    registrationArguments('--apply', workspace, inputFile),
    { cwd: workspace }
  );
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).project.summary, '日本語の説明をUTF-8のまま登録する');
  const stored = await fetchProject('registration-japanese-path');
  assert.equal(stored.response.status, 200);
  assert.equal(stored.data.name, '日本語パスのプロジェクト');
  assert.deepEqual(stored.data.currentTasks, ['日本語ファイルを検証中']);
  const mapping = JSON.parse(await fs.readFile(path.join(workspace, '.project-manager.json'), 'utf8'));
  assert.equal(mapping.project_id, 'registration-japanese-path');
  assert.equal(mapping.manager_url, baseUrl);
});

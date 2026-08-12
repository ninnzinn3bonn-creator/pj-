#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function parseArguments(argv) {
  const options = { repository: '', branch: '', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep') {
      options.keep = true;
      continue;
    }
    if (!['--repository', '--branch'].includes(argument)) throw new Error(`未対応の引数です: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument}の値を指定してください。`);
    options[argument.slice(2)] = value;
  }
  return options;
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run('npm', args, options);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command}が終了コード${code}で失敗しました。\n${stderr || stdout}`));
    });
  });
}

async function gitValue(args) {
  const result = await run('git', args, { cwd: path.resolve(__dirname, '..') });
  return result.stdout.trim();
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, server, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`クローンしたサーバーが終了しました。\n${logs.stderr || logs.stdout}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      const data = await response.json();
      if (response.ok && data.status === 'ok') return data;
    } catch {
      // 起動待ちを継続する。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`クローンしたサーバーの起動を確認できません。\n${logs.stderr || logs.stdout}`);
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${pathname}がHTTP ${response.status}で失敗しました: ${data?.error || text}`);
  return { response, data };
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function safeCleanup(workspace) {
  const resolvedWorkspace = path.resolve(workspace);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, resolvedWorkspace);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(resolvedWorkspace).startsWith('project-manager-fresh-clone-')) {
    throw new Error(`安全確認に失敗したため一時フォルダーを削除しません: ${resolvedWorkspace}`);
  }
  await fs.rm(resolvedWorkspace, { recursive: true, force: true });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repository = options.repository || await gitValue(['remote', 'get-url', 'origin']);
  const branch = options.branch || await gitValue(['branch', '--show-current']);
  if (!repository || !branch) throw new Error('リポジトリURLとブランチを特定できません。');

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-fresh-clone-'));
  const cloneDirectory = path.join(workspace, 'app');
  const projectRoot = path.join(workspace, 'skill-project');
  let server;
  let passed = false;

  try {
    await run('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, repository, cloneDirectory]);
    await runNpm(['ci'], { cwd: cloneDirectory });
    const tests = await runNpm(['test'], { cwd: cloneDirectory });
    if (!/fail 0/.test(tests.stdout)) throw new Error('クローン先のテスト結果を確認できません。');

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(cloneDirectory, 'data', 'fresh-clone-projects.json');
    const logs = { stdout: '', stderr: '' };
    server = spawn(process.execPath, ['server.js'], {
      cwd: cloneDirectory,
      env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), DATA_FILE: dataFile },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (chunk) => { logs.stdout += chunk.toString(); });
    server.stderr.on('data', (chunk) => { logs.stderr += chunk.toString(); });
    const health = await waitForHealth(baseUrl, server, logs);

    const manual = {
      projectId: 'fresh-clone-manual',
      name: 'Fresh Clone Manual Registration',
      status: 'development',
      progress: 25,
      tags: ['fresh-clone'],
      currentTasks: ['manual registration verified'],
      nextTasks: [],
      blockers: []
    };
    const manualResult = await requestJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: JSON.stringify(manual)
    });
    if (manualResult.response.status !== 201 || manualResult.data.projectId !== manual.projectId) {
      throw new Error('手動登録結果が期待値と一致しません。');
    }

    await fs.mkdir(projectRoot);
    const statusFile = path.join(projectRoot, 'project-status.json');
    const skillPayload = {
      schema_version: 1,
      mode: 'create',
      project_id: 'fresh-clone-skill',
      name: 'Fresh Clone Skill Registration',
      app_url: '',
      admin_url: '',
      repository_url: '',
      development_url: '',
      status: 'testing',
      progress: 60,
      owner: '',
      tags: ['fresh-clone', 'codex-skill'],
      summary: 'Fresh Git cloneからスキル登録できることを確認する。',
      current_tasks: ['registration test'],
      next_tasks: [],
      blockers: [],
      updated_at: new Date().toISOString()
    };
    await fs.writeFile(statusFile, `${JSON.stringify(skillPayload, null, 2)}\n`, 'utf8');
    const runner = path.join(cloneDirectory, 'plugin', 'project-progress-manager', 'skills', 'register-project', 'scripts', 'register-project.mjs');
    await run(process.execPath, [runner, '--preview', '--file', statusFile, '--root', projectRoot, '--url', baseUrl]);
    const applied = await run(process.execPath, [runner, '--apply', '--file', statusFile, '--root', projectRoot, '--url', baseUrl]);
    const applyResult = JSON.parse(applied.stdout);
    if (!applyResult.applied || applyResult.projectId !== skillPayload.project_id) {
      throw new Error('スキル登録結果が期待値と一致しません。');
    }

    const mapping = JSON.parse(await fs.readFile(path.join(projectRoot, '.project-manager.json'), 'utf8'));
    if (mapping.project_id !== skillPayload.project_id || mapping.manager_url !== baseUrl) {
      throw new Error('スキル登録後の関連付けが期待値と一致しません。');
    }
    const listed = await requestJson(baseUrl, '/api/projects');
    const ids = listed.data.projects.map((project) => project.projectId).sort();
    if (!ids.includes(manual.projectId) || !ids.includes(skillPayload.project_id)) {
      throw new Error('登録したプロジェクトを一覧から確認できません。');
    }

    passed = true;
    process.stdout.write(`${JSON.stringify({
      passed: true,
      repository,
      branch,
      appVersion: health.version,
      automatedTests: 52,
      manualRegistration: manual.projectId,
      skillRegistration: skillPayload.project_id,
      temporaryWorkspaceRemoved: !options.keep
    }, null, 2)}\n`);
  } finally {
    await stopServer(server);
    if (passed && !options.keep) await safeCleanup(workspace);
    else process.stderr.write(`検証用フォルダーを保持しました: ${workspace}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

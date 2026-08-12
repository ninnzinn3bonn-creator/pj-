#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { normalizeLoopbackUrl } = require('../lib/local-access');
const { inspectProjectRoot } = require('../lib/project-root');
const { assertSupportedNodeVersion } = require('../lib/runtime-version');
const { saveJsonAtomic } = require('../lib/storage');

assertSupportedNodeVersion();

const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_NAME = '.project-manager.json';
const DEFAULT_URL = 'http://127.0.0.1:4170';
const VALUE_OPTIONS = new Set(['url', 'file', 'source', 'request-id', 'project', 'output']);
const BOOLEAN_OPTIONS = new Set(['json', 'stdin', 'no-start', 'force']);

function parseArguments(argv) {
  const command = argv[0] || 'help';
  const options = {};
  const positionals = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    const aliases = { '-u': 'url', '-f': 'file', '-j': 'json' };
    const normalized = aliases[argument] || argument.replace(/^--/, '');
    const [name, inlineValue] = normalized.split(/=(.*)/s, 2);
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`不明なオプションです: ${argument}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name}の値を指定してください。`);
    options[name] = value;
  }

  return { command, options, positionals };
}

function normalizeUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  return normalizeLoopbackUrl(text);
}

async function findProjectConfig(startDirectory = process.cwd()) {
  let directory = path.resolve(startDirectory);
  while (true) {
    const filename = path.join(directory, CONFIG_NAME);
    try {
      const data = JSON.parse(await fs.readFile(filename, 'utf8'));
      return { filename, directory, data };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`${filename}を読み込めません: ${error.message}`);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function readSavedUrl() {
  try {
    const port = (await fs.readFile(path.join(APP_ROOT, 'data', 'server.port'), 'utf8')).trim();
    if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  } catch {
    // 保存ポートがない場合は既定値を使う。
  }
  return '';
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 5000),
    headers: options.body
      ? { 'Content-Type': 'application/json', ...(options.headers || {}) }
      : options.headers
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.details = data?.details || [];
    throw error;
  }
  return { data, response };
}

async function isHealthy(baseUrl) {
  try {
    const { data } = await requestJson(baseUrl, '/api/health', { timeout: 1500 });
    return data?.service === 'local-project-manager' && data?.status === 'ok';
  } catch {
    return false;
  }
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || APP_ROOT,
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
      else reject(new Error(stderr.trim() || stdout.trim() || `${command}が終了コード${code}で終了しました。`));
    });
  });
}

async function startLocalServer() {
  if (process.platform === 'win32') {
    await runProcess('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(APP_ROOT, 'launch.ps1'),
      '-NoBrowser'
    ]);
    return;
  }

  const child = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    cwd: APP_ROOT,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function resolveManager(options, config) {
  const configuredUrl = options.url
    || process.env.PROJECT_MANAGER_URL
    || config?.data?.manager_url
    || config?.data?.managerUrl;
  const candidates = [];
  for (const value of [configuredUrl, await readSavedUrl(), DEFAULT_URL]) {
    if (!value) continue;
    const url = normalizeUrl(value);
    if (!candidates.includes(url)) candidates.push(url);
  }

  for (const candidate of candidates) {
    if (await isHealthy(candidate)) return candidate;
  }

  if (options['no-start']) return candidates[0] || DEFAULT_URL;
  await startLocalServer();
  const startedCandidates = [await readSavedUrl(), ...candidates].filter(Boolean);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const value of startedCandidates) {
      const candidate = normalizeUrl(value);
      if (await isHealthy(candidate)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('プロジェクト管理サーバーを起動できませんでした。data/launcher.logを確認してください。');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readInput(options) {
  if (options.file) return fs.readFile(path.resolve(process.cwd(), options.file), 'utf8');
  if (options.stdin || !process.stdin.isTTY) {
    const text = await readStdin();
    if (text.trim()) return text;
  }
  throw new Error('--file <JSONファイル>を指定するか、標準入力からJSONを渡してください。');
}

function extractArchitectureJson(text) {
  const trimmed = String(text || '').trim();
  const blocks = [...trimmed.matchAll(/```(?:architecture-json|json)?\s*([\s\S]*?)```/gi)];
  const candidate = blocks.length ? blocks[0][1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`architecture JSONの構文が正しくありません: ${error.message}`);
  }
}

function mappedProjectId(config) {
  return config?.data?.project_id || config?.data?.projectId || '';
}

function resolveArchitectureProjectId(options, config, positionals = []) {
  const mapped = mappedProjectId(config);
  const explicit = options.project || positionals[0] || '';
  if (mapped && explicit && mapped !== explicit) {
    throw new Error(`対象project_idが関連付けと一致しません。期待値: ${mapped} / 指定値: ${explicit}`);
  }
  const projectId = explicit || mapped;
  if (!projectId) {
    throw new Error('対象project_idを指定するか、先にproject-manager link <project-id>を実行してください。');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(projectId)) {
    throw new Error('project_idは英数字とハイフンで指定してください。');
  }
  return projectId;
}

function assertArchitectureProject(data, projectId) {
  const actual = data?.project?.project_id;
  if (!actual) throw new Error('architecture JSONにproject.project_idがありません。');
  if (actual !== projectId) {
    throw new Error(`対象project_idが一致しません。期待値: ${projectId} / JSON: ${actual}`);
  }
}

function architectureRequestId(projectId, data) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
  return `architecture-${projectId}-${digest}`;
}

function architecturePath(projectId, suffix = '') {
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/architecture${suffix}`;
}

function renderArchitectureMeta(meta) {
  const counts = meta.counts || {};
  return [
    `概念図: ${meta.state === 'ready' ? '作成済み' : '未作成'} (${meta.projectId})`,
    `リビジョン: ${meta.revision || '—'}`,
    `更新日時: ${meta.updatedAt || '—'}`,
    `更新元: ${meta.source || '—'}`,
    `構成: ${counts.groups || 0} groups / ${counts.components || 0} components / ${counts.edges || 0} edges / ${counts.flows || 0} flows`,
    ...(meta.lastError ? [`最終エラー: ${meta.lastError}`] : [])
  ].join('\n');
}

function renderArchitecturePreview(preview) {
  const counts = preview.counts || {};
  return [
    `${preview.mode === 'create' ? '概念図を新規作成' : '概念図を更新'}: ${preview.projectId}`,
    `変更: ${preview.changed ? 'あり' : 'なし'}`,
    `現在のリビジョン: ${preview.currentRevision || '—'}`,
    `作成予定リビジョン: ${preview.proposedRevision || '—'}`,
    `構成: ${counts.groups || 0} groups / ${counts.components || 0} components / ${counts.edges || 0} edges / ${counts.flows || 0} flows`
  ].join('\n');
}

async function writeJsonFile(filename, data, { force = false } = {}) {
  const output = path.resolve(process.cwd(), filename);
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  if (!force) {
    try {
      await fs.writeFile(output, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`${output}は既に存在します。上書きする場合は--forceを指定してください。`);
      throw error;
    }
    return output;
  }
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(temporary, contents, 'utf8');
  try {
    await fs.rename(temporary, output);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return output;
}

function renderChanges(preview) {
  const lines = [`${preview.mode === 'create' ? '新規登録' : '更新'}: ${preview.project.name} (${preview.project.projectId})`];
  if (preview.mode === 'create') {
    lines.push(`状態: ${preview.project.status}`, `進捗: ${preview.project.progress}%`, `概要: ${preview.project.summary || '—'}`);
    return lines.join('\n');
  }
  const changed = preview.changes.filter((item) => item.changed);
  if (!changed.length) return `${lines[0]}\n変更はありません。`;
  for (const item of changed) {
    const before = Array.isArray(item.before) ? item.before.join(', ') : item.before;
    const after = Array.isArray(item.after) ? item.after.join(', ') : item.after;
    lines.push(`${item.label}: ${before ?? '—'} -> ${after ?? '—'}`);
  }
  return lines.join('\n');
}

function print(value, jsonMode = false) {
  if (jsonMode) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function expectedProjectId(options, config) {
  if (options.project) return options.project;
  if (options.source === 'codex-skill') return config?.data?.project_id || config?.data?.projectId || '';
  return '';
}

function assertExpectedProject(preview, projectId) {
  if (projectId && preview.project.projectId !== projectId) {
    throw new Error(`対象project_idが一致しません。期待値: ${projectId} / JSON: ${preview.project.projectId}`);
  }
}

async function previewInput(baseUrl, text, options, config) {
  const { data } = await requestJson(baseUrl, '/api/import/preview', {
    method: 'POST',
    body: JSON.stringify({ text })
  });
  assertExpectedProject(data, expectedProjectId(options, config));
  return data;
}

async function commandList(baseUrl, options) {
  const { data } = await requestJson(baseUrl, '/api/projects');
  if (options.json) return print(data, true);
  if (!data.projects.length) return print('登録されているプロジェクトはありません。');
  const lines = data.projects
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((item) => `${item.projectId}\t${item.progress}%\t${item.status}\t${item.name}`);
  print(lines.join('\n'));
}

async function commandShow(baseUrl, options, positionals) {
  const projectId = positionals[0];
  if (!projectId) throw new Error('project-manager show <project-id> の形式で指定してください。');
  const { data } = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`);
  if (options.json) return print(data, true);
  print([
    `${data.name} (${data.projectId})`,
    `状態: ${data.status}`,
    `進捗: ${data.progress}%`,
    `更新元: ${data.lastUpdateSource || '不明'}`,
    `最終更新: ${data.updatedAt}`,
    `概要: ${data.summary || '—'}`
  ].join('\n'));
}

async function commandPreview(baseUrl, options, config) {
  const text = await readInput(options);
  const preview = await previewInput(baseUrl, text, options, config);
  print(options.json ? preview : renderChanges(preview), options.json);
}

async function commandApply(baseUrl, options, config) {
  const text = await readInput(options);
  const preview = await previewInput(baseUrl, text, options, config);
  const changed = preview.mode === 'create' || preview.changes.some((item) => item.changed);
  if (!changed && !options.force) {
    const result = { applied: false, reason: 'no_changes', preview };
    return print(options.json ? result : `${renderChanges(preview)}\n更新は実行しませんでした。`, options.json);
  }

  const source = options.source || 'cli';
  const requestId = options['request-id'] || `cli-${Date.now()}-${crypto.randomUUID()}`;
  const { data, response } = await requestJson(baseUrl, '/api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ text, source, requestId })
  });
  const result = {
    applied: true,
    replayed: response.headers.get('x-idempotent-replay') === 'true',
    requestId,
    project: data
  };
  if (options.json) return print(result, true);
  print(`${renderChanges(preview)}\n反映しました。request_id: ${requestId}${result.replayed ? '（再送のため既存結果を返しました）' : ''}`);
}

async function commandArchitecture(baseUrl, options, config, positionals) {
  const action = positionals[0];
  const projectId = resolveArchitectureProjectId(options, config, positionals.slice(1));

  if (action === 'status') {
    const { data } = await requestJson(baseUrl, architecturePath(projectId, '/meta'));
    return print(options.json ? data : renderArchitectureMeta(data), options.json);
  }

  if (action === 'show') {
    const { data } = await requestJson(baseUrl, architecturePath(projectId));
    if (options.json) return print(data, true);
    return print(renderArchitectureMeta(data.meta || {
      projectId,
      state: 'ready',
      counts: {
        groups: data.architecture?.groups?.length || 0,
        components: data.architecture?.components?.length || 0,
        edges: data.architecture?.edges?.length || 0,
        flows: data.architecture?.flows?.length || 0
      }
    }));
  }

  if (action === 'preview' || action === 'apply') {
    const text = await readInput(options);
    const architecture = extractArchitectureJson(text);
    assertArchitectureProject(architecture, projectId);
    const source = options.source || 'cli';
    const { data: preview } = await requestJson(baseUrl, architecturePath(projectId, '/preview'), {
      method: 'POST',
      body: JSON.stringify({ data: architecture, source })
    });
    if (action === 'preview') {
      return print(options.json ? preview : renderArchitecturePreview(preview), options.json);
    }
    if (!preview.changed && !options.force) {
      const result = { applied: false, reason: 'no_changes', preview };
      return print(options.json ? result : `${renderArchitecturePreview(preview)}\n更新は実行しませんでした。`, options.json);
    }

    const requestId = options['request-id'] || architectureRequestId(projectId, architecture);
    const body = { data: architecture, source, requestId };
    if (preview.currentRevision) body.expectedRevision = preview.currentRevision;
    const { data: committed, response } = await requestJson(baseUrl, architecturePath(projectId, '/commit'), {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const result = {
      ...committed,
      applied: committed.applied !== false,
      replayed: committed.replayed === true || response.headers.get('x-idempotent-replay') === 'true',
      requestId
    };
    if (options.json) return print(result, true);
    return print(`${renderArchitecturePreview(preview)}\n概念図へ反映しました。request_id: ${requestId}${result.replayed ? '（再送のため既存結果を返しました）' : ''}`);
  }

  if (action === 'export') {
    const { data } = await requestJson(baseUrl, architecturePath(projectId, '/export'));
    if (!options.output) return print(data, true);
    const output = await writeJsonFile(options.output, data, { force: options.force });
    const result = { exported: true, projectId, output };
    return print(options.json ? result : `${output}へ書き出しました。`, options.json);
  }

  throw new Error('architectureにはstatus、show、preview、apply、exportのいずれかを指定してください。');
}

async function commandDoctor(baseUrl, options, config) {
  const { data } = await requestJson(baseUrl, '/api/health');
  const result = {
    ok: true,
    managerUrl: baseUrl,
    version: data.version,
    projectConfig: config?.filename || null,
    projectId: config?.data?.project_id || config?.data?.projectId || null
  };
  if (options.json) return print(result, true);
  print([
    '接続: 正常',
    `管理サイト: ${result.managerUrl}`,
    `バージョン: ${result.version}`,
    `プロジェクト設定: ${result.projectConfig || '未設定'}`,
    `対象ID: ${result.projectId || '未設定'}`
  ].join('\n'));
}

async function commandLink(baseUrl, options, positionals) {
  const projectId = positionals[0];
  if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(projectId)) {
    throw new Error('project-manager link <project-id> の形式で、英数字とハイフンのIDを指定してください。');
  }
  await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`);
  const rootInfo = await inspectProjectRoot(process.cwd());
  const filename = rootInfo.mappingPath;
  if (rootInfo.mappingExists && !options.force) {
    throw new Error(`${filename}は既に存在します。上書きする場合は--forceを指定してください。`);
  }
  const data = {
    schema_version: 1,
    project_id: projectId,
    manager_url: baseUrl
  };
  await saveJsonAtomic(filename, data, { backup: rootInfo.mappingExists, exclusive: !rootInfo.mappingExists });
  if (options.json) return print({ filename, ...data }, true);
  print(`${filename}を作成し、「${projectId}」へ関連付けました。`);
}

function showHelp() {
  print(`開発プロジェクト台帳 CLI

使い方:
  project-manager list [--json]
  project-manager show <project-id> [--json]
  project-manager preview --file status.json [--project <id>] [--json]
  Get-Content status.json | project-manager apply --stdin [--source cli] [--json]
  project-manager link <project-id> [--url http://127.0.0.1:4170]
  project-manager architecture status [<project-id>] [--json]
  project-manager architecture show [<project-id>] [--json]
  project-manager architecture preview [<project-id>] --file architecture.json [--json]
  Get-Content architecture.json | project-manager architecture apply --stdin [--source cli] [--json]
  project-manager architecture export [<project-id>] [--output architecture.json]
  project-manager doctor [--json]

共通オプション:
  --url <URL>          管理サイトURL
  --no-start           サーバーを自動起動しない
  --json               機械処理用JSONで出力

applyオプション:
  --source <source>    cli または codex-skill
  --request-id <id>    再送時の二重更新を防ぐID
  --force              差分がなくても更新する

architectureオプション:
  --project <id>       対象ID（.project-manager.jsonがある場合は一致必須）
  --output <file>      exportの保存先（既存ファイルは--forceなしで保護）`);
}

async function main() {
  const { command, options, positionals } = parseArguments(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(command)) return showHelp();
  const config = await findProjectConfig();
  const baseUrl = await resolveManager(options, config);

  if (command === 'list') return commandList(baseUrl, options);
  if (command === 'show') return commandShow(baseUrl, options, positionals);
  if (command === 'preview') return commandPreview(baseUrl, options, config);
  if (command === 'apply') return commandApply(baseUrl, options, config);
  if (command === 'doctor') return commandDoctor(baseUrl, options, config);
  if (command === 'link') return commandLink(baseUrl, options, positionals);
  if (command === 'architecture') return commandArchitecture(baseUrl, options, config, positionals);
  throw new Error(`不明なコマンドです: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`エラー: ${error.message}\n`);
  if (Array.isArray(error.details)) {
    for (const detail of error.details) process.stderr.write(`- ${detail}\n`);
  }
  process.exitCode = 1;
});

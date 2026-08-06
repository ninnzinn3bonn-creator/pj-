#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_NAME = '.project-manager.json';
const DEFAULT_URL = 'http://127.0.0.1:4170';
const VALUE_OPTIONS = new Set(['url', 'file', 'source', 'request-id', 'project', 'output']);
const BOOLEAN_OPTIONS = new Set(['json', 'stdin', 'force']);

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

async function findProjectConfig(startDirectory = process.cwd()) {
  let directory = path.resolve(startDirectory);
  while (true) {
    const filename = path.join(directory, CONFIG_NAME);
    try {
      const data = JSON.parse(await fs.readFile(filename, 'utf8'));
      return { filename, data };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`${filename}を読み込めません: ${error.message}`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function normalizeUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('管理サイトURLはhttp://またはhttps://で指定してください。');
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function requestJson(baseUrl, pathname, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(options.timeout || 7000),
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined
    });
  } catch (error) {
    throw new Error(`管理サイトへ接続できません (${baseUrl})。管理サイトを起動してください: ${error.message}`);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`管理サイトから不正な応答を受信しました (HTTP ${response.status})。`);
  }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.details = data?.details || [];
    throw error;
  }
  return { data, response };
}

async function readInput(options) {
  if (options.file) return fs.readFile(path.resolve(process.cwd(), options.file), 'utf8');
  if (options.stdin || !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim()) return text;
  }
  throw new Error('--file <JSONファイル>を指定するか、標準入力からJSONを渡してください。');
}

function extractArchitectureJson(text) {
  const trimmed = String(text || '').trim();
  const blocks = [...trimmed.matchAll(/```(?:architecture-json|json)?\s*([\s\S]*?)```/gi)];
  const candidate = blocks.length ? blocks[0][1].trim() : trimmed;
  try { return JSON.parse(candidate); } catch (error) {
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
  if (!projectId) throw new Error('対象project_idを指定するか、先にlinkコマンドを実行してください。');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(projectId)) throw new Error('project_idは英数字とハイフンで指定してください。');
  return projectId;
}

function assertArchitectureProject(data, projectId) {
  const actual = data?.project?.project_id;
  if (!actual) throw new Error('architecture JSONにproject.project_idがありません。');
  if (actual !== projectId) throw new Error(`対象project_idが一致しません。期待値: ${projectId} / JSON: ${actual}`);
}

function architecturePath(projectId, suffix = '') {
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/architecture${suffix}`;
}

function deterministicArchitectureRequestId(projectId, data) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
  return `architecture-${projectId}-${digest}`;
}

function renderArchitectureMeta(meta) {
  const counts = meta.counts || {};
  return [
    `概念図: ${meta.state === 'ready' ? '作成済み' : '未作成'} (${meta.projectId})`,
    `リビジョン: ${meta.revision || '—'}`,
    `更新日時: ${meta.updatedAt || '—'}`,
    `構成: ${counts.groups || 0} groups / ${counts.components || 0} components / ${counts.edges || 0} edges / ${counts.flows || 0} flows`
  ].join('\n');
}

async function writeJsonFile(filename, data, force) {
  const output = path.resolve(process.cwd(), filename);
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await fs.writeFile(output, contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${output}は既に存在します。上書きには--forceが必要です。`);
    throw error;
  }
  return output;
}

async function commandArchitecture(baseUrl, options, positionals, config) {
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
    const architecture = extractArchitectureJson(await readInput(options));
    assertArchitectureProject(architecture, projectId);
    const source = options.source || 'cli';
    const { data: preview } = await requestJson(baseUrl, architecturePath(projectId, '/preview'), {
      method: 'POST',
      body: JSON.stringify({ data: architecture, source })
    });
    if (action === 'preview') return print(preview, true);
    if (!preview.changed && !options.force) return print({ applied: false, reason: 'no_changes', preview }, true);
    const requestId = options['request-id'] || deterministicArchitectureRequestId(projectId, architecture);
    const commitBody = { data: architecture, source, requestId };
    if (preview.currentRevision) commitBody.expectedRevision = preview.currentRevision;
    const { data, response } = await requestJson(baseUrl, architecturePath(projectId, '/commit'), {
      method: 'POST',
      body: JSON.stringify(commitBody)
    });
    return print({
      ...data,
      applied: data.applied !== false,
      replayed: data.replayed === true || response.headers.get('x-idempotent-replay') === 'true',
      requestId
    }, true);
  }
  if (action === 'export') {
    const { data } = await requestJson(baseUrl, architecturePath(projectId, '/export'));
    if (!options.output) return print(data, true);
    const output = await writeJsonFile(options.output, data, options.force);
    return print({ exported: true, projectId, output }, options.json);
  }
  throw new Error('architectureにはstatus、show、preview、apply、exportのいずれかを指定してください。');
}

function print(value, jsonMode = false) {
  process.stdout.write(`${jsonMode ? JSON.stringify(value, null, 2) : value}\n`);
}

function expectedProjectId(options, config) {
  return options.project
    || (options.source === 'codex-skill' ? config?.data?.project_id : '')
    || '';
}

async function previewInput(baseUrl, text, options, config) {
  const { data } = await requestJson(baseUrl, '/api/import/preview', {
    method: 'POST',
    body: JSON.stringify({ text })
  });
  const expected = expectedProjectId(options, config);
  if (expected && data?.project?.projectId !== expected) {
    throw new Error(`対象project_idが一致しません。期待値: ${expected} / JSON: ${data?.project?.projectId || '未指定'}`);
  }
  return data;
}

async function main() {
  const { command, options, positionals } = parseArguments(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(command)) {
    return print([
      'Project Progress Manager CLI',
      '',
      'project-manager list [--json] [--url <URL>]',
      'project-manager show <project-id> [--json] [--url <URL>]',
      'project-manager preview --file <status.json> [--project <id>] [--json]',
      'project-manager apply --stdin [--source cli] [--request-id <id>] [--json]',
      'project-manager link <project-id> [--url <URL>] [--force]',
      'project-manager architecture status|show [<project-id>] [--json]',
      'project-manager architecture preview|apply [<project-id>] --file <architecture.json> [--json]',
      'project-manager architecture export [<project-id>] [--output <architecture.json>]',
      'project-manager doctor [--json] [--url <URL>]'
    ].join('\n'));
  }

  const config = await findProjectConfig();
  const baseUrl = normalizeUrl(options.url || process.env.PROJECT_MANAGER_URL || config?.data?.manager_url || DEFAULT_URL);

  if (command === 'doctor') {
    const { data } = await requestJson(baseUrl, '/api/health');
    return print({
      ok: data?.status === 'ok',
      managerUrl: baseUrl,
      version: data?.version,
      projectConfig: config?.filename || null,
      projectId: config?.data?.project_id || null
    }, options.json);
  }

  if (command === 'list') {
    const { data } = await requestJson(baseUrl, '/api/projects');
    if (options.json) return print(data, true);
    return print(data.projects.length
      ? data.projects.map((item) => `${item.projectId}\t${item.progress}%\t${item.status}\t${item.name}`).join('\n')
      : '登録されているプロジェクトはありません。');
  }

  if (command === 'show') {
    const projectId = positionals[0];
    if (!projectId) throw new Error('show <project-id>の形式で指定してください。');
    const { data } = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`);
    return print(data, options.json);
  }

  if (command === 'architecture') {
    return commandArchitecture(baseUrl, options, positionals, config);
  }

  if (command === 'link') {
    const projectId = positionals[0];
    if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(projectId)) {
      throw new Error('link <project-id>の形式で英数字とハイフンのIDを指定してください。');
    }
    await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`);
    const filename = path.join(process.cwd(), CONFIG_NAME);
    try {
      await fs.access(filename);
      if (!options.force) throw new Error(`${filename}は既に存在します。上書きには--forceが必要です。`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const data = { schema_version: 1, project_id: projectId, manager_url: baseUrl };
    await fs.writeFile(filename, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return print({ filename, ...data }, options.json);
  }

  if (command === 'preview' || command === 'apply') {
    const text = await readInput(options);
    const preview = await previewInput(baseUrl, text, options, config);
    if (command === 'preview') return print(preview, options.json);
    const changed = preview.mode === 'create' || preview.changes?.some((item) => item.changed);
    if (!changed && !options.force) return print({ applied: false, reason: 'no_changes', preview }, options.json);
    const requestId = options['request-id'] || `cli-${Date.now()}-${crypto.randomUUID()}`;
    const { data, response } = await requestJson(baseUrl, '/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ text, source: options.source || 'cli', requestId })
    });
    return print({
      applied: true,
      replayed: response.headers.get('x-idempotent-replay') === 'true',
      requestId,
      project: data
    }, options.json);
  }

  throw new Error(`不明なコマンドです: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`エラー: ${error.message}\n`);
  if (Array.isArray(error.details)) {
    for (const detail of error.details) process.stderr.write(`- ${detail}\n`);
  }
  process.exitCode = 1;
});

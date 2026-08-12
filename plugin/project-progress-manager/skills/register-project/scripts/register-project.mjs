#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import projectSafety from '../../../scripts/project-safety.cjs';

const { inspectProjectRoot, normalizeLoopbackUrl } = projectSafety;

const CONFIG_NAME = '.project-manager.json';
const DEFAULT_HOST = '127.0.0.1';
const FIRST_PROBE_PORT = 4170;
const LAST_PROBE_PORT = 4180;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const STATUSES = new Set([
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
]);
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
  ['release-ready', 'release_ready'],
  ['release ready', 'release_ready'],
  ['アイデア', 'idea'],
  ['構想', 'idea'],
  ['計画中', 'planning'],
  ['企画中', 'planning'],
  ['開発中', 'development'],
  ['進行中', 'development'],
  ['テスト中', 'testing'],
  ['検証中', 'testing'],
  ['リリース準備', 'release_ready'],
  ['公開準備', 'release_ready'],
  ['公開済み', 'published'],
  ['完了', 'published'],
  ['更新待ち', 'update_pending'],
  ['ブロック', 'blocked'],
  ['一時停止', 'paused'],
  ['アーカイブ済み', 'archived']
]);
const REQUIRED_FIELDS = [
  'schema_version',
  'mode',
  'project_id',
  'name',
  'app_url',
  'admin_url',
  'repository_url',
  'development_url',
  'status',
  'progress',
  'owner',
  'tags',
  'summary',
  'current_tasks',
  'next_tasks',
  'blockers',
  'updated_at'
];
const HELP_TEXT = `Project Progress Manager - new project registration

Usage:
  node register-project.mjs --preview [--file <status.json>] [--url <manager-url>] [--root <project-root>]
  node register-project.mjs --apply [--file <status.json>] [--url <manager-url>] [--root <project-root>] [--request-id <id>]

Options:
  --preview          Validate and preview without writing the register or mapping.
  --apply            Register, then create .project-manager.json after success.
  --file <path>      Read project-status JSON from a UTF-8 file (stdin when omitted).
  --url <url>        Select the project register explicitly.
  --root <path>      Select the project root (current directory by default).
  --request-id <id>  Override the deterministic idempotency key.
  -h, --help         Show this help.
`;

class RunnerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.details = details;
  }
}

class HttpError extends RunnerError {
  constructor(message, { status = 0, url = '', response = null, cause = '' } = {}) {
    super('API_ERROR', message, { status, url, response, cause });
    this.status = status;
    this.url = url;
    this.responseBody = response;
  }
}

function argumentError(message) {
  return new RunnerError('ARGUMENT_ERROR', message);
}

function takeOption(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) {
    throw argumentError(`${option} の値を指定してください。`);
  }
  return value;
}

function parseArguments(arguments_) {
  const options = {
    action: '',
    filename: '',
    managerUrl: '',
    root: process.cwd(),
    requestId: ''
  };
  const seen = new Set();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--preview' || argument === '--apply') {
      if (options.action) throw argumentError('--preview と --apply はどちらか一方だけ指定してください。');
      options.action = argument.slice(2);
      continue;
    }

    const optionNames = new Map([
      ['--file', 'filename'],
      ['--url', 'managerUrl'],
      ['--root', 'root'],
      ['--request-id', 'requestId']
    ]);
    const destination = optionNames.get(argument);
    if (!destination) throw argumentError(`未対応の引数です: ${argument}`);
    if (seen.has(argument)) throw argumentError(`${argument} は1回だけ指定してください。`);
    seen.add(argument);
    options[destination] = takeOption(arguments_, index, argument);
    index += 1;
  }

  if (!options.action) throw argumentError('--preview または --apply のどちらか一方を指定してください。');
  if (options.requestId && (options.requestId.length > 128 || !REQUEST_ID_PATTERN.test(options.requestId))) {
    throw argumentError('--request-id は128文字以内の英数字、ハイフン、ピリオド、アンダースコア、コロンで指定してください。');
  }

  options.root = path.resolve(options.root);
  if (options.filename) options.filename = path.resolve(options.filename);
  return options;
}

async function readInput(filename) {
  let text;
  if (filename) {
    try {
      text = await fs.readFile(filename, 'utf8');
    } catch (error) {
      throw new RunnerError('INPUT_ERROR', `入力ファイルを読み込めません: ${filename}`, { cause: error.message });
    }
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  }

  if (!text.trim()) {
    throw new RunnerError(
      'INPUT_ERROR',
      filename ? '入力ファイルに project-status JSON がありません。' : '標準入力に project-status JSON を渡してください。'
    );
  }
  return text.trim();
}

function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:project-status|json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const candidates = blocks.length ? blocks : [text.trim()];
  const syntaxErrors = [];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      syntaxErrors.push(error.message);
    }
  }

  throw new RunnerError('INVALID_JSON', 'project-status JSON の構文が正しくありません。', {
    syntaxErrors: syntaxErrors.slice(0, 3)
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(value) {
  const raw = typeof value === 'string' ? value.trim().normalize('NFKC').toLowerCase() : '';
  const compact = raw.replace(/[\s-]+/g, '_');
  return STATUS_ALIASES.get(raw) || STATUS_ALIASES.get(compact) || raw;
}

function normalizePayload(payload) {
  return isPlainObject(payload) ? { ...payload, status: normalizeStatus(payload.status) } : payload;
}

function validateHttpUrl(value, field, errors) {
  if (typeof value !== 'string') {
    errors.push(`${field} は文字列で指定してください。`);
    return;
  }
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      errors.push(`${field} は http:// または https:// で始まるURLにしてください。`);
    }
  } catch {
    errors.push(`${field} のURL形式が正しくありません。`);
  }
}

function isIso8601(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
  );
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  return day >= 1
    && day <= daysInMonth
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function validateString(value, field, errors, { required = false } = {}) {
  if (typeof value !== 'string') {
    errors.push(`${field} は文字列で指定してください。`);
  } else if (required && !value.trim()) {
    errors.push(`${field} は空にできません。`);
  }
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} は配列で指定してください。`);
    return;
  }
  if (value.some((item) => typeof item !== 'string')) {
    errors.push(`${field} の各項目は文字列で指定してください。`);
  }
}

function validatePayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    throw new RunnerError('VALIDATION_ERROR', 'project-status JSON の最上位はオブジェクトにしてください。');
  }

  const missing = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(payload, field));
  missing.forEach((field) => errors.push(`${field} がありません。`));
  if (missing.length) {
    throw new RunnerError('VALIDATION_ERROR', 'project-status JSON の必須項目が不足しています。', { errors });
  }

  if (payload.schema_version !== 1) errors.push('schema_version は 1 を指定してください。');
  if (payload.mode !== 'create') errors.push('新規登録では mode を create にしてください。');
  if (typeof payload.project_id !== 'string' || !PROJECT_ID_PATTERN.test(payload.project_id)) {
    errors.push('project_id は英数字で始まる英数字とハイフンだけのIDにしてください。');
  }
  validateString(payload.name, 'name', errors, { required: true });
  validateHttpUrl(payload.app_url, 'app_url', errors);
  validateHttpUrl(payload.admin_url, 'admin_url', errors);
  validateHttpUrl(payload.repository_url, 'repository_url', errors);
  validateHttpUrl(payload.development_url, 'development_url', errors);
  if (!STATUSES.has(payload.status)) errors.push('status が許可されていません。');
  if (!Number.isInteger(payload.progress) || payload.progress < 0 || payload.progress > 100) {
    errors.push('progress は 0 から 100 の整数で指定してください。');
  }
  validateString(payload.owner, 'owner', errors);
  validateString(payload.summary, 'summary', errors);
  validateStringArray(payload.tags, 'tags', errors);
  validateStringArray(payload.current_tasks, 'current_tasks', errors);
  validateStringArray(payload.next_tasks, 'next_tasks', errors);
  validateStringArray(payload.blockers, 'blockers', errors);
  if (!isIso8601(payload.updated_at)) errors.push('updated_at はタイムゾーンを含むISO 8601形式で指定してください。');

  if (errors.length) {
    throw new RunnerError('VALIDATION_ERROR', 'project-status JSON が新規登録スキーマに適合しません。', { errors });
  }
}

function normalizeManagerUrl(value) {
  try {
    return normalizeLoopbackUrl(value);
  } catch (error) {
    throw new RunnerError('INVALID_MANAGER_URL', error.message);
  }
}

async function requestJson(baseUrl, pathname, options = {}) {
  const requestUrl = `${baseUrl.replace(/\/+$/, '')}${pathname}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      method: options.method || 'GET',
      body: options.body,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(options.timeout ?? 7000)
    });
  } catch (error) {
    throw new HttpError(`管理サイトへ接続できません: ${baseUrl}`, {
      url: requestUrl,
      cause: error.message
    });
  }

  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new HttpError(`管理サイトからJSONではない応答を受信しました (HTTP ${response.status})。`, {
      status: response.status,
      url: requestUrl,
      response: responseText.slice(0, 500)
    });
  }

  if (!response.ok) {
    throw new HttpError(data?.error || `管理サイトがHTTP ${response.status}を返しました。`, {
      status: response.status,
      url: requestUrl,
      response: data
    });
  }
  return { data, response };
}

function isCompatibleManager(health, meta) {
  return health?.service === 'local-project-manager'
    && health?.schemaVersion === 1
    && health?.status === 'ok'
    && meta?.service === 'local-project-manager'
    && meta?.schemaVersion === 1;
}

async function inspectManager(managerUrl, timeout = 1500) {
  const normalizedUrl = normalizeManagerUrl(managerUrl);
  const [healthResult, metaResult] = await Promise.all([
    requestJson(normalizedUrl, '/api/health', { timeout }),
    requestJson(normalizedUrl, '/api/meta', { timeout })
  ]);
  if (!isCompatibleManager(healthResult.data, metaResult.data)) {
    throw new RunnerError('INCOMPATIBLE_MANAGER', `互換性のあるプロジェクト台帳ではありません: ${normalizedUrl}`, {
      health: healthResult.data,
      meta: metaResult.data
    });
  }
  return { url: normalizedUrl, health: healthResult.data, meta: metaResult.data };
}

async function resolveManagerUrl(explicitUrl) {
  const selected = explicitUrl || process.env.PROJECT_MANAGER_URL || '';
  if (selected) {
    try {
      return await inspectManager(selected);
    } catch (error) {
      if (error instanceof RunnerError && error.code === 'INVALID_MANAGER_URL') throw error;
      throw new RunnerError('MANAGER_UNAVAILABLE', '指定されたURLで互換性のあるプロジェクト台帳を確認できません。', {
        managerUrl: selected,
        cause: error.message
      });
    }
  }

  const candidates = [];
  for (let port = FIRST_PROBE_PORT; port <= LAST_PROBE_PORT; port += 1) {
    candidates.push(`http://${DEFAULT_HOST}:${port}`);
  }
  const settled = await Promise.all(candidates.map(async (candidate) => {
    try {
      return await inspectManager(candidate, 1200);
    } catch {
      return null;
    }
  }));
  const matches = settled.filter(Boolean);
  if (matches.length === 0) {
    throw new RunnerError('MANAGER_NOT_FOUND', 'ポート4170から4180に起動中のプロジェクト台帳が見つかりません。', {
      probed: candidates
    });
  }
  if (matches.length > 1) {
    throw new RunnerError('AMBIGUOUS_MANAGER', '複数のプロジェクト台帳が見つかったため自動選択できません。--url で指定してください。', {
      matches: matches.map((match) => match.url)
    });
  }
  return matches[0];
}

async function prepareRoot(root) {
  let rootInfo;
  try {
    rootInfo = await inspectProjectRoot(root);
  } catch (error) {
    throw new RunnerError('ROOT_ERROR', `プロジェクトルートを確認できません: ${root}`, { cause: error.message });
  }
  if (rootInfo.mappingExists) {
    throw new RunnerError('MAPPING_EXISTS', `${rootInfo.mappingPath} は既に存在します。既存の関連付けは上書きしません。`, {
      mappingPath: rootInfo.mappingPath
    });
  }
  return rootInfo;
}

function normalizedRepositoryUrl(value) {
  if (!value) return '';
  const parsed = new URL(value);
  parsed.hash = '';
  parsed.search = '';
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  return parsed.toString().replace(/\/+$/, '');
}

function assertNoRepositoryCollision(payload, projects) {
  if (!payload.repository_url) return;
  const expected = normalizedRepositoryUrl(payload.repository_url);
  const collision = projects.find((project) => project.projectId !== payload.project_id
    && normalizedRepositoryUrl(project.repositoryUrl || '') === expected);
  if (collision) {
    throw new RunnerError('REPOSITORY_CONFLICT', '同じリポジトリURLのプロジェクトが既に登録されています。', {
      projectId: collision.projectId,
      repositoryUrl: payload.repository_url
    });
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deterministicRequestId(payload) {
  const digest = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  const descriptive = `register-${payload.project_id}-${digest.slice(0, 32)}`;
  return descriptive.length <= 128 ? descriptive : `register-${digest.slice(0, 48)}`;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function recoveryLink(projectId, managerUrl, root, mappingPath) {
  return {
    action: 'link',
    projectId,
    managerUrl,
    root,
    mappingPath,
    command: `Set-Location -LiteralPath ${powershellLiteral(root)}; project-manager link ${powershellLiteral(projectId)} --url ${powershellLiteral(managerUrl)}`,
    mapping: {
      schema_version: 1,
      project_id: projectId,
      manager_url: managerUrl
    }
  };
}

async function writeMappingAtomic(mappingPath, mapping) {
  const directory = path.dirname(mappingPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(mappingPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporaryPath, mappingPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function verifyMapping(mappingPath, expected) {
  let actual;
  try {
    actual = JSON.parse(await fs.readFile(mappingPath, 'utf8'));
  } catch (error) {
    throw new Error(`関連付けファイルを再読込できません: ${error.message}`);
  }
  if (actual.schema_version !== expected.schema_version
    || actual.project_id !== expected.project_id
    || actual.manager_url !== expected.manager_url) {
    throw new Error('関連付けファイルの内容が登録結果と一致しません。');
  }
}

function projectIdFromApi(project) {
  return project?.projectId || project?.project_id || '';
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const rootInfo = await prepareRoot(options.root);
  options.root = rootInfo.root;
  const mappingPath = rootInfo.mappingPath;
  const inputText = await readInput(options.filename);
  const payload = normalizePayload(extractJson(inputText));
  validatePayload(payload);
  const canonicalText = JSON.stringify(payload);
  const manager = await resolveManagerUrl(options.managerUrl);

  let preview = null;
  let previewConflict = null;
  try {
    const previewResult = await requestJson(manager.url, '/api/import/preview', {
      method: 'POST',
      body: JSON.stringify({ text: canonicalText, expectedMode: 'create', source: 'codex-skill' })
    });
    preview = previewResult.data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      previewConflict = error;
    } else {
      throw error;
    }
  }

  const projectsResult = await requestJson(manager.url, '/api/projects');
  const projects = Array.isArray(projectsResult.data?.projects) ? projectsResult.data.projects : [];
  assertNoRepositoryCollision(payload, projects);

  if (previewConflict && options.action === 'preview') {
    throw new RunnerError('PROJECT_ID_CONFLICT', 'project_id が既に登録されています。', {
      projectId: payload.project_id,
      api: previewConflict.responseBody
    });
  }
  if (!previewConflict) {
    if (preview?.mode !== 'create') {
      throw new RunnerError('PREVIEW_MISMATCH', '管理サイトのプレビューモードが create ではありません。', {
        actualMode: preview?.mode || ''
      });
    }
    if (projectIdFromApi(preview?.project) !== payload.project_id) {
      throw new RunnerError('PREVIEW_MISMATCH', '管理サイトのプレビュー対象IDが入力と一致しません。', {
        expectedProjectId: payload.project_id,
        actualProjectId: projectIdFromApi(preview?.project)
      });
    }
  }

  const mapping = {
    schema_version: 1,
    project_id: payload.project_id,
    manager_url: manager.url
  };

  if (options.action === 'preview') {
    return {
      ok: true,
      action: 'preview',
      managerUrl: manager.url,
      projectId: payload.project_id,
      root: options.root,
      preview,
      mapping: {
        written: false,
        path: mappingPath,
        data: mapping
      }
    };
  }

  const requestId = options.requestId || deterministicRequestId(payload);
  let commitResult;
  try {
    commitResult = await requestJson(manager.url, '/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ text: canonicalText, source: 'codex-skill', requestId })
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      const apiCode = error.responseBody?.code || '';
      const apiMessage = error.responseBody?.error || '';
      let conflictCode = 'PROJECT_ID_CONFLICT';
      let conflictMessage = 'project_id が既に登録されており、この登録要求の再実行でもありません。';
      if (apiCode === 'REQUEST_REPLAY_MISSING') {
        conflictCode = 'REQUEST_REPLAY_MISSING';
        conflictMessage = 'request_idに対応する登録済みプロジェクトが見つかりません。';
      } else if (apiCode === 'REQUEST_ID_CONFLICT' || /request_id/i.test(apiMessage)) {
        conflictCode = 'REQUEST_ID_CONFLICT';
        conflictMessage = '同じrequest_idが別の登録要求に使用されています。';
      } else if (apiCode === 'REPOSITORY_CONFLICT') {
        conflictCode = 'REPOSITORY_CONFLICT';
        conflictMessage = '同じリポジトリURLのプロジェクトが既に登録されています。';
      }
      throw new RunnerError(conflictCode, conflictMessage, {
        projectId: payload.project_id,
        requestId,
        api: error.responseBody
      });
    }
    throw error;
  }

  const project = commitResult.data;
  if (projectIdFromApi(project) !== payload.project_id) {
    throw new RunnerError('COMMIT_MISMATCH', '登録されたプロジェクトIDが入力と一致しません。', {
      expectedProjectId: payload.project_id,
      actualProjectId: projectIdFromApi(project),
      registrationSucceeded: true
    });
  }
  const replayed = commitResult.response.headers.get('x-idempotent-replay') === 'true';

  try {
    await writeMappingAtomic(mappingPath, mapping);
    await verifyMapping(mappingPath, mapping);
  } catch (error) {
    const link = recoveryLink(payload.project_id, manager.url, options.root, mappingPath);
    throw new RunnerError('MAPPING_WRITE_FAILED', '台帳への登録は成功しましたが、プロジェクトの関連付けファイルを作成できませんでした。', {
      registrationSucceeded: true,
      replayed,
      projectId: payload.project_id,
      managerUrl: manager.url,
      requestId,
      cause: error.message,
      recoveryLink: link,
      recoveryCommand: link.command
    });
  }

  return {
    ok: true,
    action: 'apply',
    applied: true,
    replayed,
    requestId,
    managerUrl: manager.url,
    projectId: payload.project_id,
    root: options.root,
    mapping: {
      written: true,
      path: mappingPath,
      data: mapping
    },
    project
  };
}

function errorResult(error) {
  const normalized = error instanceof RunnerError
    ? error
    : new RunnerError('UNEXPECTED_ERROR', error?.message || String(error));
  const result = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...normalized.details
    }
  };
  if (normalized.details?.registrationSucceeded) {
    result.registrationSucceeded = true;
    result.projectId = normalized.details.projectId;
    result.managerUrl = normalized.details.managerUrl;
    result.recoveryLink = normalized.details.recoveryLink;
    result.recoveryCommand = normalized.details.recoveryCommand;
  }
  return result;
}

const commandArguments = process.argv.slice(2);
if (commandArguments.length === 1 && ['-h', '--help'].includes(commandArguments[0])) {
  process.stdout.write(HELP_TEXT);
} else {
  run()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
      process.exitCode = 1;
    });
}

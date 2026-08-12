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
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function takeOption(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(option === '--file' ? '--fileのパスを指定してください。' : `${option}の値を指定してください。`);
  }
  return value;
}

function parseArguments(arguments_) {
  const options = {
    action: '',
    requestId: '',
    filename: '',
    managerUrl: '',
    root: process.cwd()
  };
  const destinations = new Map([
    ['--request-id', 'requestId'],
    ['--file', 'filename'],
    ['--url', 'managerUrl'],
    ['--root', 'root']
  ]);
  const seen = new Set();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--preview' || argument === '--apply') {
      if (options.action) throw new Error('--previewと--applyはどちらか一方だけ指定してください。');
      options.action = argument.slice(2);
      continue;
    }
    const destination = destinations.get(argument);
    if (!destination) throw new Error(`未対応の引数です: ${argument}`);
    if (seen.has(argument)) throw new Error(`${argument}は1回だけ指定してください。`);
    seen.add(argument);
    options[destination] = takeOption(arguments_, index, argument);
    index += 1;
  }

  if (!options.action) throw new Error('--previewまたは--applyのどちらか一方を指定してください。');
  if (options.requestId && (options.requestId.length > 128 || !REQUEST_ID_PATTERN.test(options.requestId))) {
    throw new Error('--request-idは128文字以内の英数字、ハイフン、ピリオド、アンダースコア、コロンで指定してください。');
  }
  options.root = path.resolve(options.root);
  if (options.filename) options.filename = path.resolve(options.filename);
  return options;
}

async function readInput(filename) {
  let text;
  if (filename) {
    text = await fs.readFile(filename, 'utf8');
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  }
  text = text.trim();
  if (!text) {
    throw new Error(filename
      ? '--fileで指定したファイルにarchitecture JSONがありません。'
      : '標準入力にarchitecture JSONを渡してください。');
  }
  return text;
}

function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:architecture-json|json)?\s*([\s\S]*?)```/gi)];
  const candidate = blocks.length ? blocks[0][1].trim() : text.trim();
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`architecture JSONの構文が正しくありません: ${error.message}`);
  }
}

async function assertRoot(root) {
  try {
    return await inspectProjectRoot(root);
  } catch (error) {
    throw new Error(`プロジェクトルートを確認できません (${root}): ${error.message}`);
  }
}

async function findConfig(startDirectory) {
  const rootInfo = await inspectProjectRoot(startDirectory);
  if (!rootInfo.mappingExists) return null;
  try {
    const data = JSON.parse(await fs.readFile(rootInfo.mappingPath, 'utf8'));
    return { filename: rootInfo.mappingPath, data };
  } catch (error) {
    throw new Error(`${rootInfo.mappingPath}を読み込めません: ${error.message}`);
  }
}

function normalizeManagerUrl(value) {
  try {
    return normalizeLoopbackUrl(value);
  } catch (error) {
    throw new Error(error.message);
  }
}

function validateConfig(config) {
  if (!config) return null;
  if (config.data.schema_version !== 1) throw new Error(`${config.filename}のschema_versionは1である必要があります。`);
  if (!PROJECT_ID_PATTERN.test(config.data.project_id || '')) {
    throw new Error(`${config.filename}のproject_idが正しくありません。`);
  }
  return {
    projectId: config.data.project_id,
    managerUrl: normalizeManagerUrl(config.data.manager_url),
    filename: config.filename
  };
}

function validateDocument(data, expectedProjectId = '') {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['JSONの最上位はオブジェクトで指定してください。'];
  if (data.schema_version !== 1) errors.push('schema_versionは1である必要があります。');
  if (data.kind !== 'architecture-graph') errors.push('kindはarchitecture-graphである必要があります。');
  if (!data.document || !ID_PATTERN.test(data.document.id || '') || !String(data.document.title || '').trim()) {
    errors.push('documentには有効なidとtitleが必要です。');
  }
  if (!PROJECT_ID_PATTERN.test(data?.project?.project_id || '')) {
    errors.push('project.project_idは英数字で始まる英数字とハイフンだけのIDにしてください。');
  } else if (expectedProjectId && data.project.project_id !== expectedProjectId) {
    errors.push(`project.project_idが関連付けと一致しません。期待値: ${expectedProjectId} / JSON: ${data.project.project_id}`);
  }
  for (const key of ['groups', 'components', 'edges', 'flows']) {
    if (!Array.isArray(data[key])) errors.push(`${key}は配列で指定してください。`);
  }
  if (errors.length) return errors;

  const uniqueIds = (items, label) => {
    const ids = new Set();
    items.forEach((item, index) => {
      if (!ID_PATTERN.test(item?.id || '')) errors.push(`${label}[${index}].idが正しくありません。`);
      else if (ids.has(item.id)) errors.push(`${label} id「${item.id}」が重複しています。`);
      else ids.add(item.id);
    });
    return ids;
  };
  const groupIds = uniqueIds(data.groups, 'groups');
  const componentIds = uniqueIds(data.components, 'components');
  const edgeIds = uniqueIds(data.edges, 'edges');
  uniqueIds(data.flows, 'flows');

  data.components.forEach((component, index) => {
    if (!groupIds.has(component.group)) errors.push(`components[${index}].group「${component.group || ''}」が存在しません。`);
    for (const key of ['responsibilities', 'technologies', 'inputs', 'outputs', 'files']) {
      if (!Array.isArray(component[key]) || component[key].some((item) => typeof item !== 'string')) {
        errors.push(`components[${index}].${key}は文字列配列で指定してください。`);
      }
    }
  });
  data.edges.forEach((edge, index) => {
    if (!componentIds.has(edge.source)) errors.push(`edges[${index}].source「${edge.source || ''}」が存在しません。`);
    if (!componentIds.has(edge.target)) errors.push(`edges[${index}].target「${edge.target || ''}」が存在しません。`);
  });
  data.flows.forEach((flow, index) => {
    if (!Array.isArray(flow.node_ids) || flow.node_ids.some((id) => !componentIds.has(id))) errors.push(`flows[${index}].node_idsに不正な参照があります。`);
    if (!Array.isArray(flow.edge_ids) || flow.edge_ids.some((id) => !edgeIds.has(id))) errors.push(`flows[${index}].edge_idsに不正な参照があります。`);
    if (!Array.isArray(flow.steps)) errors.push(`flows[${index}].stepsは配列で指定してください。`);
  });
  return errors;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const requestUrl = `${String(baseUrl).replace(/\/+$/, '')}${pathname}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      method: options.method || 'GET',
      body: options.body,
      signal: AbortSignal.timeout(options.timeout || 7000),
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
  } catch (error) {
    throw new Error(`管理サイトへ接続できません (${baseUrl}): ${error.message}`);
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
    error.status = response.status;
    error.responseData = data;
    throw error;
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
  const [health, meta] = await Promise.all([
    requestJson(normalizedUrl, '/api/health', { timeout }),
    requestJson(normalizedUrl, '/api/meta', { timeout })
  ]);
  if (!isCompatibleManager(health.data, meta.data)) {
    throw new Error(`互換性のあるプロジェクト台帳ではありません: ${normalizedUrl}`);
  }
  return normalizedUrl;
}

async function resolveManagerUrl(explicitUrl) {
  const selected = explicitUrl || process.env.PROJECT_MANAGER_URL || '';
  if (selected) return inspectManager(selected);

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
  if (matches.length === 0) throw new Error('ポート4170から4180に起動中のプロジェクト台帳が見つかりません。');
  if (matches.length > 1) throw new Error('複数のプロジェクト台帳が見つかったため自動選択できません。--urlで指定してください。');
  return matches[0];
}

function normalizedRepositoryUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.search = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

async function verifyRegisteredProject(managerUrl, payload) {
  const projectId = payload.project.project_id;
  let result;
  try {
    result = await requestJson(managerUrl, `/api/projects/${encodeURIComponent(projectId)}`);
  } catch (error) {
    if (error.status === 404) {
      throw new Error(`project_id「${projectId}」は台帳に登録されていません。先に「台帳に新規登録」を実行してください。`);
    }
    throw error;
  }
  const actualId = result.data?.projectId || result.data?.project_id || '';
  if (actualId !== projectId) throw new Error(`台帳のプロジェクトIDが一致しません。期待値: ${projectId} / 実際: ${actualId || '未指定'}`);
  const documentRepository = normalizedRepositoryUrl(payload.project.repository_url || '');
  const registeredRepository = normalizedRepositoryUrl(result.data?.repositoryUrl || result.data?.repository_url || '');
  if (documentRepository && registeredRepository && documentRepository !== registeredRepository) {
    throw new Error(`project_id「${projectId}」のリポジトリURLが台帳と一致しません。対象を確認してください。`);
  }
  return result.data;
}

function endpoint(projectId, suffix) {
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/architecture/${suffix}`;
}

async function writeMappingAtomic(mappingPath, mapping) {
  const temporaryPath = path.join(
    path.dirname(mappingPath),
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
  const actual = JSON.parse(await fs.readFile(mappingPath, 'utf8'));
  if (actual.schema_version !== expected.schema_version
    || actual.project_id !== expected.project_id
    || normalizeManagerUrl(actual.manager_url) !== expected.manager_url) {
    throw new Error(`${mappingPath}の内容が概念図の対象と一致しません。`);
  }
}

async function ensureMapping({ config, mappingPath, mapping }) {
  if (config) {
    await verifyMapping(config.filename, mapping);
    return { written: false, path: config.filename, data: mapping };
  }
  try {
    await writeMappingAtomic(mappingPath, mapping);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await verifyMapping(mappingPath, mapping);
  return { written: true, path: mappingPath, data: mapping };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rootInfo = await assertRoot(options.root);
  options.root = rootInfo.root;
  const payload = extractJson(await readInput(options.filename));
  const config = await findConfig(options.root);
  const linked = validateConfig(config);
  const expectedProjectId = linked?.projectId || payload?.project?.project_id || '';
  const errors = validateDocument(payload, expectedProjectId);
  if (errors.length) {
    const error = new Error('architecture JSONが正しくありません。');
    error.details = errors;
    throw error;
  }

  let managerUrl;
  if (linked) {
    if (options.managerUrl && normalizeManagerUrl(options.managerUrl) !== linked.managerUrl) {
      throw new Error(`--urlが既存の関連付けと一致しません。期待値: ${linked.managerUrl}`);
    }
    managerUrl = await inspectManager(linked.managerUrl);
  } else {
    managerUrl = await resolveManagerUrl(options.managerUrl);
  }

  const projectId = payload.project.project_id;
  await verifyRegisteredProject(managerUrl, payload);
  const mappingPath = linked?.filename || rootInfo.mappingPath;
  const mapping = { schema_version: 1, project_id: projectId, manager_url: managerUrl };
  const previewResult = await requestJson(managerUrl, endpoint(projectId, 'preview'), {
    method: 'POST',
    body: JSON.stringify({ data: payload, source: 'codex-skill' })
  });
  if (previewResult.data?.projectId !== projectId) throw new Error(`プレビュー対象がproject_idと一致しません。期待値: ${projectId}`);

  if (options.action === 'preview') {
    process.stdout.write(`${JSON.stringify({
      ...previewResult.data,
      managerUrl,
      mapping: { written: false, required: !linked, path: mappingPath, data: mapping }
    }, null, 2)}\n`);
    return;
  }

  let result;
  if (!previewResult.data.changed) {
    result = { applied: false, reason: 'no_changes', preview: previewResult.data };
  } else {
    const requestId = options.requestId || `architecture-${projectId}-${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
    const commitBody = { data: payload, source: 'codex-skill', requestId };
    if (previewResult.data.currentRevision) commitBody.expectedRevision = previewResult.data.currentRevision;
    const commitResult = await requestJson(managerUrl, endpoint(projectId, 'commit'), {
      method: 'POST',
      body: JSON.stringify(commitBody)
    });
    result = {
      ...commitResult.data,
      applied: commitResult.data.applied !== false,
      replayed: commitResult.data.replayed === true || commitResult.response.headers.get('x-idempotent-replay') === 'true',
      requestId
    };
  }

  let mappingResult;
  try {
    mappingResult = await ensureMapping({ config, mappingPath, mapping });
  } catch (error) {
    throw new Error(`概念図の処理は完了しましたが、関連付けを自動作成できませんでした (${mappingPath}): ${error.message}`);
  }
  process.stdout.write(`${JSON.stringify({ ...result, managerUrl, projectId, mapping: mappingResult }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`エラー: ${error.message}\n`);
  if (Array.isArray(error.details)) error.details.forEach((detail) => process.stderr.write(`- ${detail}\n`));
  process.exitCode = 1;
});

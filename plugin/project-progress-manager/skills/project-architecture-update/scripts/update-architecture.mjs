#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_NAME = '.project-manager.json';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseAction(arguments_) {
  const apply = arguments_.includes('--apply');
  const preview = arguments_.includes('--preview');
  if (apply === preview) throw new Error('--previewまたは--applyのどちらか一方を指定してください。');
  const requestIndex = arguments_.indexOf('--request-id');
  const requestId = requestIndex >= 0 ? arguments_[requestIndex + 1] : '';
  if (requestIndex >= 0 && (!requestId || requestId.startsWith('--'))) {
    throw new Error('--request-idの値を指定してください。');
  }
  if (requestId && (requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestId))) {
    throw new Error('--request-idは128文字以内の英数字、ハイフン、ピリオド、アンダースコア、コロンで指定してください。');
  }
  const fileIndex = arguments_.indexOf('--file');
  const filename = fileIndex >= 0 ? arguments_[fileIndex + 1] : '';
  if (fileIndex >= 0 && (!filename || filename.startsWith('--'))) {
    throw new Error('--fileのパスを指定してください。');
  }
  return { action: apply ? 'apply' : 'preview', requestId, filename };
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

async function findConfig(startDirectory) {
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

function validateConfig(config) {
  if (!config) throw new Error('.project-manager.jsonが見つかりません。先にプラグイン同梱CLIのlinkコマンドを実行してください。');
  if (config.data.schema_version !== 1) throw new Error(`${config.filename}のschema_versionは1である必要があります。`);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(config.data.project_id || '')) {
    throw new Error(`${config.filename}のproject_idが正しくありません。`);
  }
  try {
    const managerUrl = new URL(config.data.manager_url);
    if (!['http:', 'https:'].includes(managerUrl.protocol)) throw new Error('protocol');
  } catch {
    throw new Error(`${config.filename}のmanager_urlが正しくありません。`);
  }
}

function validateDocument(data, config) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['JSONの最上位はオブジェクトで指定してください。'];
  if (data.schema_version !== 1) errors.push('schema_versionは1である必要があります。');
  if (data.kind !== 'architecture-graph') errors.push('kindはarchitecture-graphである必要があります。');
  if (!data.document || !ID_PATTERN.test(data.document.id || '') || !String(data.document.title || '').trim()) {
    errors.push('documentには有効なidとtitleが必要です。');
  }
  if (data?.project?.project_id !== config.data.project_id) {
    errors.push(`project.project_idが関連付けと一致しません。期待値: ${config.data.project_id} / JSON: ${data?.project?.project_id || '未指定'}`);
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
  let response;
  try {
    response = await fetch(`${String(baseUrl).replace(/\/+$/, '')}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(options.timeout || 7000),
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined
    });
  } catch (error) {
    throw new Error(`管理サイトへ接続できません (${baseUrl}): ${error.message}`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`管理サイトから不正な応答を受信しました (HTTP ${response.status})。`); }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.details = data?.details || [];
    throw error;
  }
  return { data, response };
}

function endpoint(projectId, suffix) {
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/architecture/${suffix}`;
}

async function main() {
  const { action, requestId: requestedId, filename } = parseAction(process.argv.slice(2));
  const payload = extractJson(await readInput(filename));
  const config = await findConfig(process.cwd());
  validateConfig(config);
  const errors = validateDocument(payload, config);
  if (errors.length) {
    const error = new Error('architecture JSONが正しくありません。');
    error.details = errors;
    throw error;
  }

  const projectId = config.data.project_id;
  const previewResult = await requestJson(config.data.manager_url, endpoint(projectId, 'preview'), {
    method: 'POST',
    body: JSON.stringify({ data: payload, source: 'codex-skill' })
  });
  if (previewResult.data?.projectId !== projectId) throw new Error(`プレビュー対象が関連付けと一致しません。期待値: ${projectId}`);
  if (action === 'preview') {
    process.stdout.write(`${JSON.stringify(previewResult.data, null, 2)}\n`);
    return;
  }
  if (!previewResult.data.changed) {
    process.stdout.write(`${JSON.stringify({ applied: false, reason: 'no_changes', preview: previewResult.data }, null, 2)}\n`);
    return;
  }

  const requestId = requestedId || `architecture-${projectId}-${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
  const commitBody = { data: payload, source: 'codex-skill', requestId };
  if (previewResult.data.currentRevision) commitBody.expectedRevision = previewResult.data.currentRevision;
  const commitResult = await requestJson(config.data.manager_url, endpoint(projectId, 'commit'), {
    method: 'POST',
    body: JSON.stringify(commitBody)
  });
  process.stdout.write(`${JSON.stringify({
    ...commitResult.data,
    applied: commitResult.data.applied !== false,
    replayed: commitResult.data.replayed === true || commitResult.response.headers.get('x-idempotent-replay') === 'true',
    requestId
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`エラー: ${error.message}\n`);
  if (Array.isArray(error.details)) error.details.forEach((detail) => process.stderr.write(`- ${detail}\n`));
  process.exitCode = 1;
});

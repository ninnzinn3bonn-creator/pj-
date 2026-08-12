#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import projectSafety from '../../../scripts/project-safety.cjs';

const { normalizeLoopbackUrl } = projectSafety;

const CONFIG_NAME = '.project-manager.json';

function parseAction(arguments_) {
  const apply = arguments_.includes('--apply');
  const preview = arguments_.includes('--preview');
  if (apply === preview) throw new Error('--previewまたは--applyのどちらか一方を指定してください。');
  const requestIndex = arguments_.indexOf('--request-id');
  const requestId = requestIndex >= 0 ? arguments_[requestIndex + 1] : '';
  if (requestIndex >= 0 && (!requestId || requestId.startsWith('--'))) {
    throw new Error('--request-idの値を指定してください。');
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
      ? '--fileで指定したファイルにproject-status JSONがありません。'
      : '標準入力にproject-status JSONを渡してください。');
  }
  return text;
}

function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:project-status|json)?\s*([\s\S]*?)```/gi)];
  const candidate = blocks.length ? blocks[0][1].trim() : text.trim();
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`project-status JSONの構文が正しくありません: ${error.message}`);
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
  if (!config) {
    throw new Error('.project-manager.jsonが見つかりません。先にプラグイン同梱CLIのlinkコマンドを実行してください。');
  }
  if (config.data.schema_version !== 1) throw new Error(`${config.filename}のschema_versionは1である必要があります。`);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(config.data.project_id || '')) {
    throw new Error(`${config.filename}のproject_idが正しくありません。`);
  }
  if (!config.data.manager_url) throw new Error(`${config.filename}にmanager_urlがありません。`);
}

function validatePayload(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('project-status JSONはオブジェクトで指定してください。');
  }
  if (payload.mode !== 'update') throw new Error('進捗更新ではmodeをupdateにしてください。');
  if (payload.project_id !== config.data.project_id) {
    throw new Error(`project_idが関連付けと一致しません。期待値: ${config.data.project_id} / JSON: ${payload.project_id || '未指定'}`);
  }
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

async function main() {
  const { action, requestId: requestedId, filename } = parseAction(process.argv.slice(2));
  const text = await readInput(filename);
  const payload = extractJson(text);
  const config = await findConfig(process.cwd());
  validateConfig(config);
  validatePayload(payload, config);
  const managerUrl = normalizeLoopbackUrl(config.data.manager_url);

  const previewResult = await requestJson(managerUrl, '/api/import/preview', {
    method: 'POST',
    body: JSON.stringify({ text })
  });
  if (previewResult.data?.project?.projectId !== config.data.project_id) {
    throw new Error(`プレビュー対象が関連付けと一致しません。期待値: ${config.data.project_id}`);
  }

  if (action === 'preview') {
    process.stdout.write(`${JSON.stringify(previewResult.data, null, 2)}\n`);
    return;
  }

  const changed = previewResult.data.mode === 'create'
    || previewResult.data.changes?.some((item) => item.changed);
  if (!changed) {
    process.stdout.write(`${JSON.stringify({
      applied: false,
      reason: 'no_changes',
      preview: previewResult.data
    }, null, 2)}\n`);
    return;
  }

  const requestId = requestedId
    || `codex-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
  const commitResult = await requestJson(managerUrl, '/api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ text, source: 'codex-skill', requestId })
  });
  process.stdout.write(`${JSON.stringify({
    applied: true,
    replayed: commitResult.response.headers.get('x-idempotent-replay') === 'true',
    requestId,
    project: commitResult.data
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`エラー: ${error.message}\n`);
  if (Array.isArray(error.details)) {
    for (const detail of error.details) process.stderr.write(`- ${detail}\n`);
  }
  process.exitCode = 1;
});

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_NAME = '.project-manager.json';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (![22, 24].includes(nodeMajor)) {
  throw new Error(`Project Progress ManagerにはNode.js 22または24が必要です。現在のバージョン: ${process.versions.node}`);
}

function normalizedHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function normalizeLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error(`管理サイトURLの形式が正しくありません: ${value}`);
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(normalizedHostname(parsed.hostname))) {
    throw new Error('管理サイトURLはhttp://のlocalhost、127.0.0.1、または::1に限定されています。');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

async function inspectProjectRoot(inputRoot = process.cwd()) {
  const requestedRoot = path.resolve(inputRoot);
  const root = await fs.realpath(requestedRoot);
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) throw new Error(`プロジェクトルートはディレクトリを指定してください: ${requestedRoot}`);
  const mappingPath = path.join(root, CONFIG_NAME);
  const relative = path.relative(root, mappingPath);
  if (relative !== CONFIG_NAME || path.dirname(mappingPath) !== root) {
    throw new Error('関連付けファイルはProject Root直下にのみ作成できます。');
  }
  let mappingStats = null;
  try {
    mappingStats = await fs.lstat(mappingPath);
    if (mappingStats.isSymbolicLink()) throw new Error(`シンボリックリンクの関連付けファイルは使用できません: ${mappingPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { requestedRoot, root, mappingPath, mappingExists: Boolean(mappingStats) };
}

async function writeMappingAtomic(rootInfo, data, options = {}) {
  const { mappingPath, mappingExists } = rootInfo;
  if (mappingExists && !options.force) throw new Error(`${mappingPath}は既に存在します。上書きしません。`);
  const temporaryPath = path.join(rootInfo.root, `.${CONFIG_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (mappingExists) await fs.copyFile(mappingPath, `${mappingPath}.bak`);
    if (mappingExists) await fs.rename(temporaryPath, mappingPath);
    else await fs.link(temporaryPath, mappingPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return mappingPath;
}

module.exports = { CONFIG_NAME, inspectProjectRoot, normalizeLoopbackUrl, writeMappingAtomic };

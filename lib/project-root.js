'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const CONFIG_NAME = '.project-manager.json';

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function inspectProjectRoot(inputRoot = process.cwd()) {
  const requestedRoot = path.resolve(inputRoot);
  const root = await fs.realpath(requestedRoot);
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) throw new Error(`プロジェクトルートはディレクトリを指定してください: ${requestedRoot}`);

  const mappingPath = path.join(root, CONFIG_NAME);
  if (!isInside(root, mappingPath) || path.dirname(mappingPath) !== root) {
    throw new Error('関連付けファイルはProject Root直下にのみ作成できます。');
  }

  let mappingStats = null;
  try {
    mappingStats = await fs.lstat(mappingPath);
    if (mappingStats.isSymbolicLink()) {
      throw new Error(`シンボリックリンクの関連付けファイルは使用できません: ${mappingPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { requestedRoot, root, mappingPath, mappingExists: Boolean(mappingStats) };
}

module.exports = { CONFIG_NAME, inspectProjectRoot, isInside };

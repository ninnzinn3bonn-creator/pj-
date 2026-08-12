'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeFileDurably(filename, contents) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function saveJsonAtomic(filename, value, options = {}) {
  const directory = path.dirname(filename);
  const basename = path.basename(filename);
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const temporaryFile = path.join(directory, `.${basename}.${token}.tmp`);
  const backupFile = options.backupFile || `${filename}.bak`;
  const backupTemporaryFile = path.join(directory, `.${basename}.${token}.bak.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(directory, { recursive: true });
  await writeFileDurably(temporaryFile, contents);

  try {
    if (options.backup !== false && await pathExists(filename)) {
      await fs.copyFile(filename, backupTemporaryFile);
      await fs.rm(backupFile, { force: true });
      await fs.rename(backupTemporaryFile, backupFile);
    }
    if (options.exclusive) {
      await fs.link(temporaryFile, filename);
      await fs.rm(temporaryFile, { force: true });
    } else {
      await fs.rename(temporaryFile, filename);
    }
  } finally {
    await fs.rm(temporaryFile, { force: true });
    await fs.rm(backupTemporaryFile, { force: true });
  }

  return { filename, backupFile: options.backup === false ? null : backupFile };
}

async function loadJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

module.exports = { loadJson, pathExists, saveJsonAtomic };

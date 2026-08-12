'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeLoopbackUrl } = require('../lib/local-access');
const { inspectProjectRoot, isInside } = require('../lib/project-root');
const { assertSupportedNodeVersion } = require('../lib/runtime-version');
const { loadJson, saveJsonAtomic } = require('../lib/storage');

test('JSON保存は一時ファイル置換と1世代バックアップを使う', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-storage-'));
  const filename = path.join(directory, 'projects.json');
  try {
    const first = { schemaVersion: 1, projects: [{ projectId: 'first' }] };
    const second = { schemaVersion: 1, projects: [{ projectId: 'second' }] };
    await saveJsonAtomic(filename, first, { backup: false });
    await saveJsonAtomic(filename, second);
    assert.deepEqual(await loadJson(filename), second);
    assert.deepEqual(await loadJson(`${filename}.bak`), first);
    assert.deepEqual(await fs.readdir(directory), ['projects.json', 'projects.json.bak']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Project Rootは実体パスへ正規化し関連付け先を直下に固定する', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'project-manager-root-'));
  const root = path.join(parent, 'project');
  await fs.mkdir(root);
  try {
    const info = await inspectProjectRoot(path.join(root, '.'));
    assert.equal(info.root, await fs.realpath(root));
    assert.equal(info.mappingPath, path.join(info.root, '.project-manager.json'));
    assert.equal(info.mappingExists, false);
    assert.equal(isInside(info.root, path.join(info.root, 'src', 'app.js')), true);
    assert.equal(isInside(info.root, path.join(parent, 'outside.json')), false);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('管理サイトURLはlocalhostだけを許可する', () => {
  assert.equal(normalizeLoopbackUrl('http://127.0.0.1:4170/'), 'http://127.0.0.1:4170');
  assert.equal(normalizeLoopbackUrl('http://localhost:4171'), 'http://localhost:4171');
  assert.throws(() => normalizeLoopbackUrl('http://192.168.1.10:4170'), /localhost/);
  assert.throws(() => normalizeLoopbackUrl('https://example.com'), /localhost/);
});

test('対応Nodeメジャーを22と24に固定する', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.20.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.13.0'));
  assert.throws(() => assertSupportedNodeVersion('23.0.0'), /Node.js 22または24/);
});

test('配布スキルは固定ランナー以外の破壊的操作を許可しない', async () => {
  const skillRoot = path.resolve(__dirname, '..', 'plugin', 'project-progress-manager', 'skills');
  for (const name of ['register-project', 'project-progress-update', 'project-architecture-update']) {
    const text = await fs.readFile(path.join(skillRoot, name, 'SKILL.md'), 'utf8');
    assert.match(text, /loopback URL/);
    assert.match(text, /reset --hard/);
    assert.match(text, /fixed .* runner/i);
  }
});

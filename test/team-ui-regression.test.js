'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

test('共有操作は統合表示ではなくチーム版revisionを使う', async () => {
  const source = await readFile(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /project\?\._teamVersion\?\.revision/);
  assert.doesNotMatch(source, /expectedRevision:\s*(?:existing|previous|project)\.revision/);
  assert.match(source, /await saveSharedProject\(existing, payload\)/);
  assert.match(source, /await saveSharedProject\(previous, payload\)/);
});

test('AI更新は競合状態を自動上書きせず概念図はローカル優先で解決する', async () => {
  const source = await readFile(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /merged\._syncState === 'local-ahead'/);
  assert.match(source, /if \(project\._local\) \{/);
  assert.match(source, /error\.status !== 404 \|\| !project\._teamVersion\?\.architecture/);
});

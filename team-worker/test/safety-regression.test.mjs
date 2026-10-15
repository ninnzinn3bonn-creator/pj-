import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('D1共有解除は論理削除・権限確認・最終管理者保護を行う', async () => {
  const source = await readFile(new URL('../src/d1-store.mjs', import.meta.url), 'utf8');
  assert.match(source, /SET deleted_at = \?1, deleted_by = \?2/);
  assert.doesNotMatch(source, /DELETE FROM projects/);
  assert.match(source, /PROJECT_DELETE_DENIED/);
  assert.match(source, /LAST_ADMIN/);
  assert.match(source, /deleted_at IS NULL/);
});

test('固定接続トークンは平文保存せず有効メンバーだけを認証する', async () => {
  const source = await readFile(new URL('../src/d1-store.mjs', import.meta.url), 'utf8');
  assert.match(source, /token_hash/);
  assert.match(source, /token_cipher/);
  assert.match(source, /m\.active = 1/);
  assert.doesNotMatch(source, /VALUES[^\n]*\btoken\b/);
});

test('チーム共通閲覧トークンは専用テーブルで暗号化し閲覧APIだけに制限する', async () => {
  const store = await readFile(new URL('../src/d1-store.mjs', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const viewer = await readFile(new URL('../public/viewer/app.js', import.meta.url), 'utf8');
  assert.match(store, /team_viewer_tokens/);
  assert.match(store, /randomToken\('pmv_'\)/);
  assert.match(store, /token_hash/);
  assert.match(store, /token_cipher/);
  assert.match(worker, /VIEWER_READ_ONLY/);
  assert.match(worker, /url\.pathname === '\/api\/viewer\/projects' && request\.method === 'GET'/);
  assert.doesNotMatch(viewer, /method:\s*['"](?:POST|PUT|DELETE)['"]/);
  assert.doesNotMatch(viewer, /[?&]token=/);
});

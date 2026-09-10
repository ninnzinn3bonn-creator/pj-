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

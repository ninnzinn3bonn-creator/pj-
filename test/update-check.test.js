'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, releaseStatus } = require('../lib/update-check');
test('semantic version comparison detects newer releases', () => {
  assert.equal(compareVersions('v1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.2.0', 'v1.2.0'), 0);
  assert.equal(compareVersions('1.1.9', '1.2.0'), -1);
});
test('release status accepts only the versioned application zip', () => {
  const result = releaseStatus('1.1.0', { tag_name: 'v1.2.0', html_url: 'https://example.test/release', body: 'Changes', published_at: '2026-09-10T00:00:00Z', assets: [{ name: 'notes.txt', browser_download_url: 'https://example.test/no' }, { name: 'local-project-manager-v1.2.0.zip', browser_download_url: 'https://example.test/app.zip', digest: 'sha256:abc' }] });
  assert.equal(result.available, true);
  assert.equal(result.downloadUrl, 'https://example.test/app.zip');
  assert.equal(result.digest, 'sha256:abc');
});

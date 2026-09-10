'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const sync = require('../public/team-sync.js');
const base = { projectId:'demo', name:'Demo', status:'development', progress:50, tags:[], currentTasks:[], nextTasks:[], blockers:[], updatedAt:'2026-01-01T00:00:00Z' };
test('team sync states distinguish local, team and concurrent changes', () => {
  const team = { ...base, revision:'1' }; const fp = sync.fingerprint(base); const meta = { localFingerprint:fp, teamFingerprint:fp, teamRevision:'1' };
  assert.equal(sync.classify(base, team, meta).state, 'synced');
  assert.equal(sync.classify({ ...base, progress:60 }, team, meta).state, 'local-ahead');
  assert.equal(sync.classify(base, { ...team, progress:70, revision:'2' }, meta).state, 'team-ahead');
  assert.equal(sync.classify({ ...base, progress:60 }, { ...team, progress:70, revision:'2' }, meta).state, 'conflict');
});

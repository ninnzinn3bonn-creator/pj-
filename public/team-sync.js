(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeamSync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FIELDS = ['projectId','name','appUrl','adminUrl','repositoryUrl','developmentUrl','status','progress','owner','tags','summary','currentTasks','nextTasks','blockers'];
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value ?? '';
  }
  function fingerprint(project) { return JSON.stringify(stable(Object.fromEntries(FIELDS.map(field => [field, project?.[field] ?? (['tags','currentTasks','nextTasks','blockers'].includes(field) ? [] : '')])))); }
  function classify(local, team, meta) {
    if (!local) return { state: 'team-only' };
    if (!team) return { state: 'local-only' };
    const localFingerprint = fingerprint(local); const teamFingerprint = fingerprint(team);
    if (localFingerprint === teamFingerprint) return { state: 'synced', localFingerprint, teamFingerprint };
    if (!meta?.localFingerprint || !meta?.teamRevision) {
      const localTime = Date.parse(local.updatedAt) || 0; const teamTime = Date.parse(team.updatedAt) || 0;
      return { state: localTime > teamTime ? 'local-ahead' : teamTime > localTime ? 'team-ahead' : 'unverified', localFingerprint, teamFingerprint };
    }
    const localChanged = localFingerprint !== meta.localFingerprint;
    const teamChanged = String(team.revision || '') !== String(meta.teamRevision) || teamFingerprint !== meta.teamFingerprint;
    return { state: localChanged && teamChanged ? 'conflict' : localChanged ? 'local-ahead' : teamChanged ? 'team-ahead' : 'unverified', localFingerprint, teamFingerprint };
  }
  function differences(local, team) { return FIELDS.filter(field => JSON.stringify(local?.[field] ?? '') !== JSON.stringify(team?.[field] ?? '')).map(field => ({ field, local: local?.[field], team: team?.[field] })); }
  function threeWayMerge(base, draft, latest) {
    const merged = { ...latest };
    const conflicts = [];
    for (const field of FIELDS) {
      const baseValue = base?.[field];
      const draftValue = draft?.[field];
      const latestValue = latest?.[field];
      const localChanged = JSON.stringify(draftValue ?? '') !== JSON.stringify(baseValue ?? '');
      const remoteChanged = JSON.stringify(latestValue ?? '') !== JSON.stringify(baseValue ?? '');
      if (!localChanged) continue;
      if (remoteChanged && JSON.stringify(draftValue ?? '') !== JSON.stringify(latestValue ?? '')) {
        conflicts.push({ field, base: baseValue, local: draftValue, team: latestValue });
      } else {
        merged[field] = draftValue;
      }
    }
    return { merged, conflicts };
  }
  return { FIELDS, fingerprint, classify, differences, threeWayMerge };
}));

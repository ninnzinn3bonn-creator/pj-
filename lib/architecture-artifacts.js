'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { saveJsonAtomic } = require('./storage');
const { validateArchitecture } = require('./architecture-schema');

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const STORAGE_SCHEMA_VERSION = 1;
const MAX_APPLIED_REQUESTS = 100;

function artifactError(status, message, details = []) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function assertProjectId(projectId) {
  if (!PROJECT_ID_PATTERN.test(projectId || '')) {
    throw artifactError(400, 'プロジェクトIDが正しくありません。');
  }
  return projectId;
}

function projectDirectory(rootDirectory, projectId) {
  assertProjectId(projectId);
  return path.join(path.resolve(rootDirectory), projectId);
}

function architectureFilename(rootDirectory, projectId) {
  return path.join(projectDirectory(rootDirectory, projectId), 'architecture.json');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function revisionValue(architecture) {
  const document = { ...architecture.document };
  const project = { ...architecture.project };
  delete document.generated_at;
  delete project.analyzed_at;
  return { ...architecture, document, project };
}

function fullDocumentRevision(architecture) {
  return crypto.createHash('sha256').update(stableStringify(architecture)).digest('hex');
}

function architectureRevision(architecture) {
  return fullDocumentRevision(revisionValue(architecture));
}

function extractArchitectureJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw artifactError(400, '概念図JSONが見つかりません。', ['入力内容が空です。']);
  }
  const trimmed = text.trim();
  const blocks = [];
  const fencePattern = /```(?:architecture-json|architecture|json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(trimmed)) !== null) blocks.push(match[1].trim());
  const candidates = blocks.length ? blocks : [trimmed];
  const syntaxErrors = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      syntaxErrors.push(error.message);
    }
  }
  if (!blocks.length && !trimmed.startsWith('{')) {
    throw artifactError(400, '概念図JSONが見つかりません。', ['architecture-jsonまたはjsonコードブロック、もしくは生JSONを指定してください。']);
  }
  throw artifactError(400, '概念図JSONの構文が正しくありません。', syntaxErrors.slice(0, 3));
}

function validateForProject(architecture, projectId) {
  assertProjectId(projectId);
  const errors = validateArchitecture(architecture);
  if (errors.length) throw artifactError(400, '概念図JSONが正しくありません。', errors);
  if (architecture.project.project_id !== projectId) {
    throw artifactError(400, '概念図JSONのproject_idが対象プロジェクトと一致しません。', [
      `期待値: ${projectId}`,
      `JSON: ${architecture.project.project_id}`
    ]);
  }
  return architecture;
}

function countsFor(architecture) {
  return {
    groups: architecture.groups.length,
    components: architecture.components.length,
    edges: architecture.edges.length,
    flows: architecture.flows.length
  };
}

function diffCollection(before, after) {
  const beforeMap = new Map((before || []).map((item) => [item.id, stableStringify(item)]));
  const afterMap = new Map((after || []).map((item) => [item.id, stableStringify(item)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  afterMap.forEach((serialized, id) => {
    if (!beforeMap.has(id)) added += 1;
    else if (beforeMap.get(id) !== serialized) changed += 1;
    else unchanged += 1;
  });
  beforeMap.forEach((_serialized, id) => { if (!afterMap.has(id)) removed += 1; });
  return { added, removed, changed, unchanged };
}

function compareArchitectures(before, after) {
  const beforeRevisionValue = before ? revisionValue(before) : null;
  const afterRevisionValue = revisionValue(after);
  return {
    documentChanged: before
      ? stableStringify(beforeRevisionValue.document) !== stableStringify(afterRevisionValue.document)
      : true,
    projectChanged: before
      ? stableStringify(beforeRevisionValue.project) !== stableStringify(afterRevisionValue.project)
      : true,
    groups: diffCollection(before?.groups, after.groups),
    components: diffCollection(before?.components, after.components),
    edges: diffCollection(before?.edges, after.edges),
    flows: diffCollection(before?.flows, after.flows)
  };
}

function validateEnvelope(record, projectId) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.storageSchemaVersion !== STORAGE_SCHEMA_VERSION) {
    throw artifactError(500, '保存されている概念図ファイルの構造が正しくありません。');
  }
  if (record.projectId !== projectId) throw artifactError(500, '保存されている概念図のプロジェクトIDが一致しません。');
  try {
    validateForProject(record.architecture, projectId);
  } catch (error) {
    throw artifactError(500, '保存されている概念図JSONが正しくありません。', error.details || [error.message]);
  }
  const revision = architectureRevision(record.architecture);
  const legacyRevision = fullDocumentRevision(record.architecture);
  const isLegacyRevision = record.revision === legacyRevision && record.revision !== revision;
  if (isLegacyRevision) record = { ...record, revision };
  if (record.revision !== revision) throw artifactError(500, '保存されている概念図のrevisionが一致しません。');
  const appliedRequests = Array.isArray(record.appliedRequests)
    ? record.appliedRequests.map((entry) => {
      if (!isLegacyRevision || !entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const migrated = { ...entry };
      if (migrated.fingerprint === legacyRevision) migrated.fingerprint = revision;
      if (migrated.revision === legacyRevision) migrated.revision = revision;
      return migrated;
    })
    : [];
  return {
    ...record,
    appliedRequests
  };
}

async function ensureRoot(rootDirectory) {
  await fs.mkdir(path.resolve(rootDirectory), { recursive: true });
}

async function readRecord(rootDirectory, projectId) {
  const filename = architectureFilename(rootDirectory, projectId);
  let text;
  try {
    text = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw artifactError(500, '保存されている概念図JSONを読み込めません。', [error.message]);
  }
  return validateEnvelope(record, projectId);
}

async function writeRecordAtomic(rootDirectory, record) {
  const directory = projectDirectory(rootDirectory, record.projectId);
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'architecture.json');
  await saveJsonAtomic(filename, record);
}

function makeRecord(projectId, architecture, options = {}) {
  validateForProject(architecture, projectId);
  const revision = architectureRevision(architecture);
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    projectId,
    revision,
    updatedAt: options.updatedAt || new Date().toISOString(),
    source: options.source || 'web-ai',
    appliedRequests: Array.isArray(options.appliedRequests) ? options.appliedRequests.slice(-MAX_APPLIED_REQUESTS) : [],
    architecture
  };
}

function recordRequest(record, entry) {
  const current = Array.isArray(record.appliedRequests) ? record.appliedRequests : [];
  record.appliedRequests = [...current, entry].slice(-MAX_APPLIED_REQUESTS);
}

function recordMeta(record) {
  if (!record) return null;
  return {
    exists: true,
    projectId: record.projectId,
    revision: record.revision,
    updatedAt: record.updatedAt,
    source: record.source,
    generatedAt: record.architecture.document.generated_at || '',
    counts: countsFor(record.architecture)
  };
}

async function listRecords(rootDirectory, projectIds) {
  const records = [];
  for (const projectId of projectIds) {
    const record = await readRecord(rootDirectory, projectId);
    if (record) records.push(record);
  }
  return records;
}

async function stageProjectRemoval(rootDirectory, projectId) {
  const source = projectDirectory(rootDirectory, projectId);
  try {
    await fs.access(source);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const trashRoot = path.join(path.resolve(rootDirectory), '.trash');
  await fs.mkdir(trashRoot, { recursive: true });
  const staged = path.join(trashRoot, `${projectId}-${Date.now()}-${crypto.randomUUID()}`);
  await fs.rename(source, staged);
  return {
    async rollback() {
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.rename(staged, source);
    },
    async commit() {
      await fs.rm(staged, { recursive: true, force: true });
    }
  };
}

module.exports = {
  MAX_APPLIED_REQUESTS,
  architectureFilename,
  architectureRevision,
  compareArchitectures,
  countsFor,
  ensureRoot,
  extractArchitectureJson,
  listRecords,
  makeRecord,
  readRecord,
  recordMeta,
  recordRequest,
  stableStringify,
  stageProjectRemoval,
  validateForProject,
  writeRecordAtomic
};

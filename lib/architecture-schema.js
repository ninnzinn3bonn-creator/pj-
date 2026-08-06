'use strict';

// Architecture Explorer schema v1. Kept local so the project manager remains
// runnable when its sibling development directory is not present.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateArchitecture(data) {
  const errors = [];
  if (!isObject(data)) return ['JSONの最上位はオブジェクトである必要があります。'];
  if (data.schema_version !== 1) errors.push('schema_versionは1である必要があります。');
  if (data.kind !== 'architecture-graph') errors.push('kindはarchitecture-graphである必要があります。');

  if (!isObject(data.document)) {
    errors.push('documentオブジェクトが必要です。');
  } else {
    if (!ID_PATTERN.test(data.document.id || '')) errors.push('document.idが正しくありません。');
    if (typeof data.document.title !== 'string' || !data.document.title.trim()) errors.push('document.titleは必須です。');
    for (const key of ['summary', 'generated_at']) {
      if (data.document[key] !== undefined && typeof data.document[key] !== 'string') errors.push(`document.${key}は文字列で指定してください。`);
    }
  }

  if (!isObject(data.project)) {
    errors.push('projectオブジェクトが必要です。');
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(data.project.project_id || '')) errors.push('project.project_idは英数字とハイフンで指定してください。');
    if (typeof data.project.name !== 'string' || !data.project.name.trim()) errors.push('project.nameは必須です。');
    for (const key of ['summary', 'version', 'analyzed_at', 'source_root', 'app_url', 'admin_url', 'repository_url', 'development_url', 'status']) {
      if (data.project[key] !== undefined && typeof data.project[key] !== 'string') errors.push(`project.${key}は文字列で指定してください。`);
    }
    for (const key of ['app_url', 'admin_url', 'repository_url', 'development_url']) {
      const value = data.project[key];
      if (!value) continue;
      try {
        if (!['http:', 'https:'].includes(new URL(value).protocol)) errors.push(`project.${key}はHTTP/HTTPS URLにしてください。`);
      } catch {
        errors.push(`project.${key}のURL形式が正しくありません。`);
      }
    }
    if (data.project.progress !== undefined && (!Number.isInteger(data.project.progress) || data.project.progress < 0 || data.project.progress > 100)) {
      errors.push('project.progressは0〜100の整数で指定してください。');
    }
    if (data.project.tags !== undefined && !isStringArray(data.project.tags)) errors.push('project.tagsは文字列配列で指定してください。');
  }

  for (const key of ['groups', 'components', 'edges', 'flows']) {
    if (!Array.isArray(data[key])) errors.push(`${key}は配列で指定してください。`);
  }
  if (errors.length) return errors;

  const groupIds = new Set();
  data.groups.forEach((group, index) => {
    if (!isObject(group)) return errors.push(`groups[${index}]はオブジェクトで指定してください。`);
    if (!ID_PATTERN.test(group.id || '')) errors.push(`groups[${index}].idが正しくありません。`);
    else if (groupIds.has(group.id)) errors.push(`group id「${group.id}」が重複しています。`);
    else groupIds.add(group.id);
    if (typeof group.name !== 'string' || !group.name.trim()) errors.push(`groups[${index}].nameは必須です。`);
    if (group.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(group.color)) errors.push(`groups[${index}].colorは#RRGGBB形式にしてください。`);
  });

  const componentIds = new Set();
  data.components.forEach((component, index) => {
    if (!isObject(component)) return errors.push(`components[${index}]はオブジェクトで指定してください。`);
    if (!ID_PATTERN.test(component.id || '')) errors.push(`components[${index}].idが正しくありません。`);
    else if (componentIds.has(component.id)) errors.push(`component id「${component.id}」が重複しています。`);
    else componentIds.add(component.id);
    if (typeof component.name !== 'string' || !component.name.trim()) errors.push(`components[${index}].nameは必須です。`);
    if (!groupIds.has(component.group)) errors.push(`components[${index}].group「${component.group || ''}」が存在しません。`);
    if (typeof component.type !== 'string' || !component.type.trim()) errors.push(`components[${index}].typeは必須です。`);
    if (typeof component.role !== 'string') errors.push(`components[${index}].roleは文字列で指定してください。`);
    for (const key of ['responsibilities', 'technologies', 'inputs', 'outputs', 'files']) {
      if (!isStringArray(component[key])) errors.push(`components[${index}].${key}は文字列配列で指定してください。`);
    }
    if (component.position !== undefined && (!isObject(component.position) || !Number.isFinite(component.position.x) || !Number.isFinite(component.position.y))) {
      errors.push(`components[${index}].positionには数値のxとyを指定してください。`);
    }
  });

  const edgeIds = new Set();
  data.edges.forEach((edge, index) => {
    if (!isObject(edge)) return errors.push(`edges[${index}]はオブジェクトで指定してください。`);
    if (!ID_PATTERN.test(edge.id || '')) errors.push(`edges[${index}].idが正しくありません。`);
    else if (edgeIds.has(edge.id)) errors.push(`edge id「${edge.id}」が重複しています。`);
    else edgeIds.add(edge.id);
    if (!componentIds.has(edge.source)) errors.push(`edges[${index}].source「${edge.source || ''}」が存在しません。`);
    if (!componentIds.has(edge.target)) errors.push(`edges[${index}].target「${edge.target || ''}」が存在しません。`);
    for (const key of ['label', 'type', 'protocol', 'description']) {
      if (typeof edge[key] !== 'string') errors.push(`edges[${index}].${key}は文字列で指定してください。`);
    }
  });

  const flowIds = new Set();
  data.flows.forEach((flow, index) => {
    if (!isObject(flow)) return errors.push(`flows[${index}]はオブジェクトで指定してください。`);
    if (!ID_PATTERN.test(flow.id || '')) errors.push(`flows[${index}].idが正しくありません。`);
    else if (flowIds.has(flow.id)) errors.push(`flow id「${flow.id}」が重複しています。`);
    else flowIds.add(flow.id);
    if (typeof flow.name !== 'string' || !flow.name.trim()) errors.push(`flows[${index}].nameは必須です。`);
    if (typeof flow.description !== 'string') errors.push(`flows[${index}].descriptionは文字列で指定してください。`);
    if (!isStringArray(flow.node_ids)) errors.push(`flows[${index}].node_idsは文字列配列で指定してください。`);
    else flow.node_ids.forEach((id) => { if (!componentIds.has(id)) errors.push(`flow「${flow.id}」のnode「${id}」が存在しません。`); });
    if (!isStringArray(flow.edge_ids)) errors.push(`flows[${index}].edge_idsは文字列配列で指定してください。`);
    else flow.edge_ids.forEach((id) => { if (!edgeIds.has(id)) errors.push(`flow「${flow.id}」のedge「${id}」が存在しません。`); });
    if (!Array.isArray(flow.steps)) errors.push(`flows[${index}].stepsは配列で指定してください。`);
    else flow.steps.forEach((step, stepIndex) => {
      if (!isObject(step) || typeof step.title !== 'string' || typeof step.description !== 'string') {
        errors.push(`flows[${index}].steps[${stepIndex}]にはtitleとdescriptionが必要です。`);
      }
      if (step?.component_id && !componentIds.has(step.component_id)) errors.push(`flow stepのcomponent_id「${step.component_id}」が存在しません。`);
      if (step?.edge_id && !edgeIds.has(step.edge_id)) errors.push(`flow stepのedge_id「${step.edge_id}」が存在しません。`);
    });
  });

  if (data.presentation !== undefined && !isObject(data.presentation)) {
    errors.push('presentationはオブジェクトで指定してください。');
  } else if (data.presentation?.default_flow_id && !flowIds.has(data.presentation.default_flow_id)) {
    errors.push(`presentation.default_flow_id「${data.presentation.default_flow_id}」が存在しません。`);
  }
  return errors;
}

module.exports = { ID_PATTERN, validateArchitecture };

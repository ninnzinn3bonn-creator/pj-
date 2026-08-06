(function architectureViewerModule(global) {
  'use strict';

  const NODE_WIDTH = 220;
  const NODE_HEIGHT = 96;
  let viewerSequence = 0;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function list(value, fallback = '—') {
    return Array.isArray(value) && value.length ? value.map(escapeHtml).join('<br>') : fallback;
  }

  function truncate(value, length = 28) {
    const text = String(value || '');
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  function validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ['JSONの最上位はオブジェクトにしてください。'];
    if (data.schema_version !== 1) errors.push('schema_versionは1にしてください。');
    if (data.kind !== 'architecture-graph') errors.push('kindはarchitecture-graphにしてください。');
    if (!data.project || typeof data.project.project_id !== 'string' || typeof data.project.name !== 'string') errors.push('project.project_idとproject.nameが必要です。');
    for (const key of ['groups', 'components', 'edges', 'flows']) {
      if (!Array.isArray(data[key])) errors.push(`${key}は配列にしてください。`);
    }
    if (errors.length) return errors;

    const validId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    const groupIds = new Set();
    const componentIds = new Set();
    const edgeIds = new Set();
    const flowIds = new Set();
    data.groups.forEach((group) => {
      if (!group || !validId.test(group.id || '') || groupIds.has(group.id)) errors.push(`group idが不正または重複しています: ${group?.id || '未指定'}`);
      else groupIds.add(group.id);
      if (group?.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(group.color)) errors.push(`group「${group?.id || ''}」のcolorは#RRGGBB形式にしてください。`);
    });
    data.components.forEach((component) => {
      if (!component || !validId.test(component.id || '') || componentIds.has(component.id)) errors.push(`component idが不正または重複しています: ${component?.id || '未指定'}`);
      else componentIds.add(component.id);
      if (!groupIds.has(component?.group)) errors.push(`component「${component?.id || ''}」のgroupが存在しません。`);
      if (typeof component?.name !== 'string' || !component.name.trim() || typeof component?.type !== 'string' || !component.type.trim() || typeof component?.role !== 'string') errors.push(`component「${component?.id || ''}」のname、type、roleを確認してください。`);
      for (const key of ['responsibilities', 'technologies', 'inputs', 'outputs', 'files']) {
        if (!Array.isArray(component?.[key]) || !component[key].every((item) => typeof item === 'string')) errors.push(`component「${component?.id || ''}」の${key}は文字列配列にしてください。`);
      }
      if (component?.position !== undefined && (!component.position || !Number.isFinite(component.position.x) || !Number.isFinite(component.position.y))) errors.push(`component「${component?.id || ''}」のpositionを確認してください。`);
    });
    data.edges.forEach((edge) => {
      if (!edge || !validId.test(edge.id || '') || edgeIds.has(edge.id)) errors.push(`edge idが不正または重複しています: ${edge?.id || '未指定'}`);
      else edgeIds.add(edge.id);
      if (!componentIds.has(edge?.source) || !componentIds.has(edge?.target)) errors.push(`edge「${edge?.id || ''}」の接続先が存在しません。`);
      for (const key of ['label', 'type', 'protocol', 'description']) {
        if (typeof edge?.[key] !== 'string') errors.push(`edge「${edge?.id || ''}」の${key}は文字列にしてください。`);
      }
    });
    data.flows.forEach((flow) => {
      if (!flow || !validId.test(flow.id || '') || flowIds.has(flow.id) || !Array.isArray(flow.node_ids) || !Array.isArray(flow.edge_ids)) {
        errors.push(`flow「${flow?.id || '未指定'}」の構造が正しくないかIDが重複しています。`);
        return;
      }
      flowIds.add(flow.id);
      if (typeof flow.name !== 'string' || !flow.name.trim() || typeof flow.description !== 'string' || !Array.isArray(flow.steps)) errors.push(`flow「${flow.id}」のname、description、stepsを確認してください。`);
      flow.node_ids.forEach((id) => { if (!componentIds.has(id)) errors.push(`flow「${flow.id}」のnode「${id}」が存在しません。`); });
      flow.edge_ids.forEach((id) => { if (!edgeIds.has(id)) errors.push(`flow「${flow.id}」のedge「${id}」が存在しません。`); });
      if (Array.isArray(flow.steps)) flow.steps.forEach((step, index) => {
        if (!step || typeof step.title !== 'string' || typeof step.description !== 'string') errors.push(`flow「${flow.id}」のsteps[${index}]を確認してください。`);
        if (step?.component_id && !componentIds.has(step.component_id)) errors.push(`flow「${flow.id}」のcomponent_id「${step.component_id}」が存在しません。`);
        if (step?.edge_id && !edgeIds.has(step.edge_id)) errors.push(`flow「${flow.id}」のedge_id「${step.edge_id}」が存在しません。`);
      });
    });
    return errors;
  }

  class Viewer {
    constructor(root, options) {
      if (!(root instanceof Element)) throw new Error('Viewerのマウント先が必要です。');
      const errors = validate(options?.data);
      if (errors.length) throw new Error(errors.join('\n'));
      this.root = root;
      this.data = structuredClone(options.data);
      this.onNotify = typeof options.onNotify === 'function' ? options.onNotify : () => {};
      this.instanceId = `architecture-viewer-${++viewerSequence}`;
      this.abortController = new AbortController();
      this.state = {
        activeFlowId: this.data.presentation?.default_flow_id || '',
        selectedNodeId: '', selectedEdgeId: '', search: '', group: '', type: '',
        transform: { x: 40, y: 40, scale: 1 }, positions: new Map(), drag: null, viewTouched: false
      };
      this.renderShell();
      this.bindStaticEvents();
      this.renderAll(true);
    }

    renderShell() {
      const patternId = `${this.instanceId}-grid`;
      const arrowId = `${this.instanceId}-arrow`;
      const activeArrowId = `${this.instanceId}-arrow-active`;
      this.ids = { patternId, arrowId, activeArrowId };
      this.root.classList.add('architecture-viewer');
      this.root.innerHTML = `
        <section class="av-toolbar" aria-label="概念図の表示フィルター">
          <label><span>コンポーネントを検索</span><input data-av="search" type="search" placeholder="名前、役割、技術、入出力、ファイル"></label>
          <label><span>領域</span><select data-av="group-filter"><option value="">すべて</option></select></label>
          <label><span>種類</span><select data-av="type-filter"><option value="">すべて</option></select></label>
          <div class="av-view-controls" aria-label="図の操作">
            <button data-av="zoom-out" type="button" aria-label="縮小">−</button>
            <button data-av="zoom-in" type="button" aria-label="拡大">＋</button>
            <span data-av="zoom-level" class="av-zoom-level" aria-live="polite">100%</span>
            <button data-av="fit-view" type="button">全体表示</button>
          </div>
        </section>
        <section class="av-workspace">
          <section class="av-graph-panel" aria-labelledby="${this.instanceId}-graph-title">
            <div class="av-panel-heading">
              <h3 id="${this.instanceId}-graph-title">アーキテクチャ図</h3>
              <span data-av="result-count" class="av-result-count" aria-live="polite"></span>
            </div>
            <div data-av="viewport" class="av-graph-viewport" tabindex="0" aria-label="アーキテクチャ図。矢印キーで移動、プラスとマイナスで拡大縮小、0で全体表示します。">
              <svg data-av="graph" class="av-graph" role="group" aria-labelledby="${this.instanceId}-graph-title ${this.instanceId}-graph-description">
                <desc id="${this.instanceId}-graph-description">コンポーネントと依存関係を示すインタラクティブな図です。</desc>
                <defs>
                  <pattern id="${patternId}" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="#dfe2e5" stroke-width="1"/></pattern>
                  <marker id="${arrowId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 z" fill="#777d84"/></marker>
                  <marker id="${activeArrowId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 z" fill="#245f72"/></marker>
                </defs>
                <rect class="av-graph-grid" width="100%" height="100%" fill="url(#${patternId})"></rect>
                <g data-av="scene"></g>
              </svg>
              <div data-av="tooltip" class="av-tooltip" role="tooltip" hidden></div>
              <div data-av="empty" class="av-empty" hidden>条件に一致するコンポーネントがありません。</div>
            </div>
            <div data-av="inspector" class="av-inspector empty" aria-live="polite">コンポーネントまたは接続を選択すると詳細を確認できます。</div>
          </section>
          <aside class="av-flow-panel" aria-labelledby="${this.instanceId}-flow-title">
            <div class="av-panel-heading">
              <h3 id="${this.instanceId}-flow-title">主要フロー</h3>
              <button data-av="clear-flow" type="button" disabled>選択解除</button>
            </div>
            <div data-av="flow-details"></div>
            <ul data-av="flow-list" class="av-flow-list"></ul>
          </aside>
        </section>
        <div data-av="legend" class="av-legend" aria-label="領域の凡例"></div>`;
      this.elements = Object.fromEntries(Array.from(this.root.querySelectorAll('[data-av]')).map((element) => [element.dataset.av, element]));
    }

    bindStaticEvents() {
      const signal = this.abortController.signal;
      this.elements.search.addEventListener('input', () => {
        this.state.search = this.elements.search.value.trim().toLocaleLowerCase('ja');
        this.state.viewTouched = false;
        this.renderGraph();
        requestAnimationFrame(() => this.fit());
      }, { signal });
      this.elements['group-filter'].addEventListener('change', () => {
        this.state.group = this.elements['group-filter'].value;
        this.state.viewTouched = false;
        this.renderGraph();
        requestAnimationFrame(() => this.fit());
      }, { signal });
      this.elements['type-filter'].addEventListener('change', () => {
        this.state.type = this.elements['type-filter'].value;
        this.state.viewTouched = false;
        this.renderGraph();
        requestAnimationFrame(() => this.fit());
      }, { signal });
      this.elements['clear-flow'].addEventListener('click', () => {
        this.state.activeFlowId = '';
        this.renderFlows();
        this.renderGraph();
      }, { signal });
      this.elements['zoom-in'].addEventListener('click', () => this.zoom(1.2), { signal });
      this.elements['zoom-out'].addEventListener('click', () => this.zoom(1 / 1.2), { signal });
      this.elements['fit-view'].addEventListener('click', () => { this.state.viewTouched = false; this.fit(); }, { signal });
      this.elements.viewport.addEventListener('wheel', (event) => {
        event.preventDefault();
        this.zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
      }, { passive: false, signal });
      this.elements.viewport.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('.av-node, .av-edge-hit')) return;
        this.state.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: this.state.transform.x, originY: this.state.transform.y };
        this.elements.viewport.setPointerCapture(event.pointerId);
        this.elements.viewport.classList.add('dragging');
      }, { signal });
      this.elements.viewport.addEventListener('pointermove', (event) => {
        if (!this.state.drag || this.state.drag.pointerId !== event.pointerId) return;
        this.state.transform.x = this.state.drag.originX + event.clientX - this.state.drag.startX;
        this.state.transform.y = this.state.drag.originY + event.clientY - this.state.drag.startY;
        this.state.viewTouched = true;
        this.updateTransform();
      }, { signal });
      const finishDrag = (event) => {
        if (!this.state.drag || this.state.drag.pointerId !== event.pointerId) return;
        this.state.drag = null;
        this.elements.viewport.classList.remove('dragging');
      };
      this.elements.viewport.addEventListener('pointerup', finishDrag, { signal });
      this.elements.viewport.addEventListener('pointercancel', finishDrag, { signal });
      this.elements.viewport.addEventListener('dblclick', () => { this.state.viewTouched = false; this.fit(); }, { signal });
      this.elements.viewport.addEventListener('keydown', (event) => {
        if (['+', '='].includes(event.key)) { event.preventDefault(); this.zoom(1.2); return; }
        if (event.key === '-') { event.preventDefault(); this.zoom(1 / 1.2); return; }
        if (event.key === '0') { event.preventDefault(); this.state.viewTouched = false; this.fit(); return; }
        const movement = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] }[event.key];
        if (!movement) return;
        event.preventDefault();
        this.state.transform.x += movement[0];
        this.state.transform.y += movement[1];
        this.state.viewTouched = true;
        this.updateTransform();
      }, { signal });
      global.addEventListener('resize', () => { if (!this.state.viewTouched) requestAnimationFrame(() => this.fit()); }, { signal });
    }

    setData(data) {
      const errors = validate(data);
      if (errors.length) throw new Error(errors.join('\n'));
      this.data = structuredClone(data);
      Object.assign(this.state, {
        activeFlowId: data.presentation?.default_flow_id || '', selectedNodeId: '', selectedEdgeId: '',
        search: '', group: '', type: '', viewTouched: false
      });
      this.elements.search.value = '';
      this.elements.inspector.className = 'av-inspector empty';
      this.elements.inspector.textContent = 'コンポーネントまたは接続を選択すると詳細を確認できます。';
      this.renderAll(true);
    }

    computePositions() {
      const groupOrder = new Map(this.data.groups.map((group, index) => [group.id, index]));
      const counters = new Map();
      const positions = new Map();
      this.data.components.forEach((component) => {
        if (component.position && Number.isFinite(component.position.x) && Number.isFinite(component.position.y)) {
          positions.set(component.id, { x: component.position.x, y: component.position.y });
          return;
        }
        const groupIndex = groupOrder.get(component.group) || 0;
        const row = counters.get(component.group) || 0;
        counters.set(component.group, row + 1);
        positions.set(component.id, { x: groupIndex * 290, y: row * 150 });
      });
      this.state.positions = positions;
    }

    componentMap() { return new Map(this.data.components.map((component) => [component.id, component])); }
    edgeMap() { return new Map(this.data.edges.map((edge) => [edge.id, edge])); }
    groupMap() { return new Map(this.data.groups.map((group) => [group.id, group])); }

    visibleComponents() {
      return this.data.components.filter((component) => {
        if (this.state.group && component.group !== this.state.group) return false;
        if (this.state.type && component.type !== this.state.type) return false;
        if (!this.state.search) return true;
        const haystack = [component.id, component.name, component.type, component.role,
          ...(component.responsibilities || []), ...(component.technologies || []),
          ...(component.inputs || []), ...(component.outputs || []), ...(component.files || [])]
          .join(' ').toLocaleLowerCase('ja');
        return haystack.includes(this.state.search);
      });
    }

    edgePath(source, target, offset = 0) {
      const sourceCenter = { x: source.x + NODE_WIDTH / 2, y: source.y + NODE_HEIGHT / 2 };
      const targetCenter = { x: target.x + NODE_WIDTH / 2, y: target.y + NODE_HEIGHT / 2 };
      if (source.x === target.x && source.y === target.y) {
        const startX = source.x + NODE_WIDTH - 38;
        const endX = source.x + NODE_WIDTH;
        const topY = source.y;
        const loopSize = Math.max(42, 68 + offset);
        return { d: `M ${startX} ${topY} C ${startX} ${topY - loopSize}, ${endX + loopSize} ${topY - loopSize}, ${endX} ${topY + 30}`, labelX: endX + loopSize / 2, labelY: topY - loopSize + 20 };
      }
      const horizontal = Math.abs(targetCenter.x - sourceCenter.x) >= Math.abs(targetCenter.y - sourceCenter.y);
      if (horizontal) {
        const forward = targetCenter.x >= sourceCenter.x;
        const start = { x: source.x + (forward ? NODE_WIDTH : 0), y: sourceCenter.y };
        const end = { x: target.x + (forward ? 0 : NODE_WIDTH), y: targetCenter.y };
        const bend = Math.max(55, Math.abs(end.x - start.x) * .42);
        const direction = forward ? 1 : -1;
        return { d: `M ${start.x} ${start.y} C ${start.x + bend * direction} ${start.y + offset}, ${end.x - bend * direction} ${end.y + offset}, ${end.x} ${end.y}`, labelX: (start.x + end.x) / 2, labelY: (start.y + end.y) / 2 + offset * .75 - 6 };
      }
      const downward = targetCenter.y >= sourceCenter.y;
      const start = { x: sourceCenter.x, y: source.y + (downward ? NODE_HEIGHT : 0) };
      const end = { x: targetCenter.x, y: target.y + (downward ? 0 : NODE_HEIGHT) };
      const bend = Math.max(45, Math.abs(end.y - start.y) * .42);
      const direction = downward ? 1 : -1;
      return { d: `M ${start.x} ${start.y} C ${start.x + offset} ${start.y + bend * direction}, ${end.x + offset} ${end.y - bend * direction}, ${end.x} ${end.y}`, labelX: (start.x + end.x) / 2 + offset * .75 + 8, labelY: (start.y + end.y) / 2 - 4 };
    }

    renderGraph() {
      const groups = this.groupMap();
      const visible = this.visibleComponents();
      const visibleIds = new Set(visible.map((component) => component.id));
      const activeFlow = this.data.flows.find((flow) => flow.id === this.state.activeFlowId);
      const activeNodes = new Set(activeFlow?.node_ids || []);
      const activeEdges = new Set(activeFlow?.edge_ids || []);
      const groupParts = [];
      const edgeParts = [];
      const nodeParts = [];
      const byGroup = new Map();
      visible.forEach((component) => {
        const point = this.state.positions.get(component.id);
        if (!byGroup.has(component.group)) byGroup.set(component.group, []);
        byGroup.get(component.group).push(point);
      });
      byGroup.forEach((points, groupId) => {
        const group = groups.get(groupId);
        const minX = Math.min(...points.map((point) => point.x)) - 22;
        const minY = Math.min(...points.map((point) => point.y)) - 38;
        const maxX = Math.max(...points.map((point) => point.x)) + NODE_WIDTH + 22;
        const maxY = Math.max(...points.map((point) => point.y)) + NODE_HEIGHT + 22;
        groupParts.push(`<g><rect class="av-group-band" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${escapeHtml(group?.color || '#697078')}" stroke="${escapeHtml(group?.color || '#697078')}"></rect><text class="av-group-label" x="${minX + 8}" y="${minY + 19}">${escapeHtml(group?.name || groupId)}</text></g>`);
      });
      const pairTotals = new Map();
      const pairUsed = new Map();
      this.data.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).forEach((edge) => {
        const key = `${edge.source}|${edge.target}`;
        pairTotals.set(key, (pairTotals.get(key) || 0) + 1);
      });
      this.data.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).forEach((edge) => {
        const key = `${edge.source}|${edge.target}`;
        const pairIndex = pairUsed.get(key) || 0;
        pairUsed.set(key, pairIndex + 1);
        const offset = (pairIndex - (pairTotals.get(key) - 1) / 2) * 30;
        const path = this.edgePath(this.state.positions.get(edge.source), this.state.positions.get(edge.target), offset);
        const active = activeEdges.has(edge.id);
        const selected = this.state.selectedEdgeId === edge.id;
        const dimmed = activeFlow && !active;
        edgeParts.push(`<g class="av-edge${active ? ' active' : ''}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}" data-av-edge-id="${escapeHtml(edge.id)}"><path class="av-edge-line" d="${path.d}" marker-end="url(#${active ? this.ids.activeArrowId : this.ids.arrowId})"></path><path class="av-edge-hit" d="${path.d}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${escapeHtml(edge.label || `${edge.source}から${edge.target}`)}"></path><text class="av-edge-label" x="${path.labelX}" y="${path.labelY}">${escapeHtml(truncate(edge.label, 24))}</text></g>`);
      });
      visible.forEach((component) => {
        const point = this.state.positions.get(component.id);
        const group = groups.get(component.group);
        const active = activeNodes.has(component.id);
        const selected = this.state.selectedNodeId === component.id;
        const dimmed = activeFlow && !active;
        const technologies = (component.technologies || []).slice(0, 2).join(' / ') || '技術情報なし';
        nodeParts.push(`<g class="av-node${active ? ' active' : ''}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}" transform="translate(${point.x} ${point.y})" data-av-node-id="${escapeHtml(component.id)}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${escapeHtml(component.name)}。${escapeHtml(component.role || '')}"><rect class="av-node-card" width="${NODE_WIDTH}" height="${NODE_HEIGHT}"></rect><rect class="av-node-accent" width="5" height="${NODE_HEIGHT}" fill="${escapeHtml(group?.color || '#697078')}"></rect><text class="av-node-title" x="16" y="27">${escapeHtml(truncate(component.name, 27))}</text><text class="av-node-type" x="16" y="48">${escapeHtml(truncate(component.type, 31))}</text><line x1="16" y1="59" x2="204" y2="59" stroke="#d4d7da"></line><text class="av-node-tech" x="16" y="79">${escapeHtml(truncate(technologies, 31))}</text></g>`);
      });
      this.elements.scene.innerHTML = `${groupParts.join('')}<g>${edgeParts.join('')}</g><g>${nodeParts.join('')}</g>`;
      this.elements['result-count'].textContent = `${visible.length} / ${this.data.components.length} コンポーネント・${edgeParts.length} 接続`;
      this.elements.empty.hidden = visible.length !== 0;
      this.updateTransform();
      this.bindGraphItems();
    }

    bindGraphItems() {
      this.elements.scene.querySelectorAll('[data-av-node-id]').forEach((node) => {
        const component = this.componentMap().get(node.dataset.avNodeId);
        node.addEventListener('pointerenter', (event) => this.showTooltip(this.tooltipForComponent(component), event.clientX, event.clientY));
        node.addEventListener('pointermove', (event) => this.positionTooltip(event.clientX, event.clientY));
        node.addEventListener('pointerleave', () => this.hideTooltip());
        node.addEventListener('focus', () => { const box = node.getBoundingClientRect(); this.showTooltip(this.tooltipForComponent(component), box.right, box.top); });
        node.addEventListener('blur', () => this.hideTooltip());
        node.addEventListener('click', () => this.selectNode(component.id));
        node.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.selectNode(component.id); } });
      });
      this.elements.scene.querySelectorAll('[data-av-edge-id]').forEach((group) => {
        const edge = this.edgeMap().get(group.dataset.avEdgeId);
        const hit = group.querySelector('.av-edge-hit');
        hit.addEventListener('pointerenter', (event) => this.showTooltip(this.tooltipForEdge(edge), event.clientX, event.clientY));
        hit.addEventListener('pointermove', (event) => this.positionTooltip(event.clientX, event.clientY));
        hit.addEventListener('pointerleave', () => this.hideTooltip());
        hit.addEventListener('focus', () => { const box = hit.getBoundingClientRect(); this.showTooltip(this.tooltipForEdge(edge), box.right, box.top); });
        hit.addEventListener('blur', () => this.hideTooltip());
        hit.addEventListener('click', () => this.selectEdge(edge.id));
        hit.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.selectEdge(edge.id); } });
      });
    }

    tooltipForComponent(component) {
      const group = this.groupMap().get(component.group);
      return `<h4>${escapeHtml(component.name)}</h4><p class="av-tooltip-kind">${escapeHtml(group?.name || component.group)} / ${escapeHtml(component.type)}</p><dl><dt>役割</dt><dd>${escapeHtml(component.role || '—')}</dd><dt>責務</dt><dd>${list(component.responsibilities)}</dd><dt>技術</dt><dd>${list(component.technologies)}</dd><dt>入力</dt><dd>${list(component.inputs)}</dd><dt>出力</dt><dd>${list(component.outputs)}</dd><dt>関連ファイル</dt><dd>${list(component.files)}</dd></dl>`;
    }

    tooltipForEdge(edge) {
      return `<h4>${escapeHtml(edge.label || `${edge.source} → ${edge.target}`)}</h4><p class="av-tooltip-kind">${escapeHtml(edge.type || 'connection')} / ${escapeHtml(edge.protocol || '—')}</p><dl><dt>接続元</dt><dd>${escapeHtml(edge.source)}</dd><dt>接続先</dt><dd>${escapeHtml(edge.target)}</dd><dt>説明</dt><dd>${escapeHtml(edge.description || '—')}</dd></dl>`;
    }

    showTooltip(html, clientX, clientY) {
      this.elements.tooltip.innerHTML = html;
      this.elements.tooltip.hidden = false;
      this.positionTooltip(clientX, clientY);
    }

    positionTooltip(clientX, clientY) {
      if (this.elements.tooltip.hidden) return;
      const bounds = this.elements.viewport.getBoundingClientRect();
      const tooltipBounds = this.elements.tooltip.getBoundingClientRect();
      let left = clientX - bounds.left + 14;
      let top = clientY - bounds.top + 14;
      if (left + tooltipBounds.width > bounds.width - 8) left = clientX - bounds.left - tooltipBounds.width - 14;
      if (top + tooltipBounds.height > bounds.height - 8) top = bounds.height - tooltipBounds.height - 8;
      this.elements.tooltip.style.left = `${Math.max(8, left)}px`;
      this.elements.tooltip.style.top = `${Math.max(8, top)}px`;
    }

    hideTooltip() { this.elements.tooltip.hidden = true; }

    selectNode(id) {
      this.state.selectedNodeId = id;
      this.state.selectedEdgeId = '';
      const component = this.componentMap().get(id);
      const group = this.groupMap().get(component.group);
      this.elements.inspector.classList.remove('empty');
      this.elements.inspector.innerHTML = `<div class="av-inspector-title"><h4>${escapeHtml(component.name)}</h4><code>${escapeHtml(component.id)}</code></div><div class="av-inspector-grid"><section><h5>役割</h5><p>${escapeHtml(component.role || '—')}</p></section><section><h5>領域・種類</h5><p>${escapeHtml(group?.name || component.group)} / ${escapeHtml(component.type)}</p></section><section><h5>使用技術</h5><p>${list(component.technologies)}</p></section><section><h5>責務</h5><ul>${(component.responsibilities || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>—</li>'}</ul></section><section><h5>入出力</h5><p><strong>IN:</strong> ${list(component.inputs)}<br><strong>OUT:</strong> ${list(component.outputs)}</p></section><section><h5>関連ファイル</h5><p>${list(component.files)}</p></section></div>`;
      this.renderGraph();
      requestAnimationFrame(() => this.elements.scene.querySelector(`[data-av-node-id="${CSS.escape(id)}"]`)?.focus());
    }

    selectEdge(id) {
      this.state.selectedEdgeId = id;
      this.state.selectedNodeId = '';
      const edge = this.edgeMap().get(id);
      const source = this.componentMap().get(edge.source);
      const target = this.componentMap().get(edge.target);
      this.elements.inspector.classList.remove('empty');
      this.elements.inspector.innerHTML = `<div class="av-inspector-title"><h4>${escapeHtml(edge.label || `${edge.source} → ${edge.target}`)}</h4><code>${escapeHtml(edge.id)}</code></div><div class="av-inspector-grid"><section><h5>接続元</h5><p>${escapeHtml(source?.name || edge.source)}</p></section><section><h5>接続先</h5><p>${escapeHtml(target?.name || edge.target)}</p></section><section><h5>種類・プロトコル</h5><p>${escapeHtml(edge.type || '—')} / ${escapeHtml(edge.protocol || '—')}</p></section><section><h5>説明</h5><p>${escapeHtml(edge.description || '—')}</p></section></div>`;
      this.renderGraph();
      requestAnimationFrame(() => this.elements.scene.querySelector(`[data-av-edge-id="${CSS.escape(id)}"] .av-edge-hit`)?.focus());
    }

    renderFilters() {
      const groupValue = this.state.group;
      const typeValue = this.state.type;
      this.elements['group-filter'].innerHTML = `<option value="">すべて</option>${this.data.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}`;
      const types = [...new Set(this.data.components.map((component) => component.type))].sort((a, b) => a.localeCompare(b, 'ja'));
      this.elements['type-filter'].innerHTML = `<option value="">すべて</option>${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}`;
      this.elements['group-filter'].value = groupValue;
      this.elements['type-filter'].value = typeValue;
    }

    renderFlows() {
      const active = this.data.flows.find((flow) => flow.id === this.state.activeFlowId);
      this.elements['clear-flow'].disabled = !active;
      this.elements['flow-details'].innerHTML = active
        ? `<div class="av-flow-details"><h4>${escapeHtml(active.name)}</h4><p>${escapeHtml(active.description || '')}</p><ol>${(active.steps || []).map((step) => `<li><strong>${escapeHtml(step.title)}</strong>${escapeHtml(step.description)}</li>`).join('')}</ol></div>`
        : '<div class="av-flow-empty">フローを選択すると、関連ノードと接続を強調表示します。</div>';
      this.elements['flow-list'].innerHTML = this.data.flows.map((flow) => `<li><button type="button" class="av-flow-button${flow.id === this.state.activeFlowId ? ' active' : ''}" data-av-flow-id="${escapeHtml(flow.id)}" aria-pressed="${flow.id === this.state.activeFlowId}"><span>${escapeHtml(flow.name)}</span><small>${escapeHtml(flow.description || '')}</small></button></li>`).join('');
      this.elements['flow-list'].querySelectorAll('[data-av-flow-id]').forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.avFlowId;
        this.state.activeFlowId = this.state.activeFlowId === id ? '' : id;
        this.renderFlows();
        this.renderGraph();
        requestAnimationFrame(() => Array.from(this.elements['flow-list'].querySelectorAll('[data-av-flow-id]')).find((item) => item.dataset.avFlowId === id)?.focus());
      }));
    }

    renderLegend() {
      this.elements.legend.innerHTML = this.data.groups.map((group) => `<span><i style="background:${escapeHtml(group.color || '#697078')}"></i>${escapeHtml(group.name)}</span>`).join('');
    }

    renderAll(fit = false) {
      this.computePositions();
      this.renderFilters();
      this.renderFlows();
      this.renderLegend();
      this.renderGraph();
      if (fit) requestAnimationFrame(() => this.fit());
    }

    updateTransform() {
      const { x, y, scale } = this.state.transform;
      this.elements.scene.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
      this.elements['zoom-level'].textContent = `${Math.round(scale * 100)}%`;
    }

    fit() {
      const visible = this.visibleComponents();
      if (!visible.length) return;
      const points = visible.map((component) => this.state.positions.get(component.id));
      const minX = Math.min(...points.map((point) => point.x)) - 50;
      const minY = Math.min(...points.map((point) => point.y)) - 65;
      const maxX = Math.max(...points.map((point) => point.x)) + NODE_WIDTH + 50;
      const maxY = Math.max(...points.map((point) => point.y)) + NODE_HEIGHT + 50;
      const width = Math.max(1, this.elements.viewport.clientWidth);
      const height = Math.max(1, this.elements.viewport.clientHeight);
      const scale = Math.min(1.35, Math.max(.28, Math.min(width / (maxX - minX), height / (maxY - minY))));
      this.state.transform = { x: (width - (maxX - minX) * scale) / 2 - minX * scale, y: (height - (maxY - minY) * scale) / 2 - minY * scale, scale };
      this.updateTransform();
    }

    zoom(factor, clientX, clientY) {
      const rect = this.elements.viewport.getBoundingClientRect();
      const pointX = clientX === undefined ? rect.width / 2 : clientX - rect.left;
      const pointY = clientY === undefined ? rect.height / 2 : clientY - rect.top;
      const oldScale = this.state.transform.scale;
      const scale = Math.min(2.8, Math.max(.25, oldScale * factor));
      this.state.transform.x = pointX - (pointX - this.state.transform.x) * (scale / oldScale);
      this.state.transform.y = pointY - (pointY - this.state.transform.y) * (scale / oldScale);
      this.state.transform.scale = scale;
      this.state.viewTouched = true;
      this.updateTransform();
    }

    destroy() {
      this.abortController.abort();
      this.root.classList.remove('architecture-viewer');
      this.root.replaceChildren();
    }
  }

  global.ArchitectureViewer = Object.freeze({
    mount(root, options) { return new Viewer(root, options); },
    validate
  });
})(window);

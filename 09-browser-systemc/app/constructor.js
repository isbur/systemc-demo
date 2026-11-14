/**
 * Канва на JointJS (@joint/core).
 * Граф — источник правды для проводов: каждый link с портами
 * проецируется в SimEngine.connections как { fromEl, fromPin, toEl, toPin }.
 * Симулятор по-прежнему сам гоняет дельта-циклы и ядра блоков.
 */
import { dia, shapes, elementTools, linkTools } from './vendor/joint/joint.js';
import { GATES, LogicElement, isBuiltinType } from './elements.js';
import { findFreeTopLeft } from './placement.js';

const ON_COLOR = '#4fc3f7';
const OFF_COLOR = '#5c6b7a';
const PORT_IN_IDLE = '#2c3150';
const PORT_OUT_IDLE = '#4a5168';

const ROUTER = {
  name: 'manhattan',
  args: {
    padding: 8,
    step: 10,
    maximumLoops: 4000,
    excludeEnds: ['source', 'target'],
    startDirections: ['right'],
    endDirections: ['left'],
  },
};

const CONNECTOR = { name: 'rounded', args: { radius: 8 } };

const Block = dia.Element.define('sc.Block', {
  size: { width: 112, height: 64 },
  attrs: {
    root: { magnet: false, cursor: 'move' },
    body: {
      width: 'calc(w)',
      height: 'calc(h)',
      rx: 8,
      ry: 8,
      fill: '#333333',
      stroke: '#c5c8d6',
      strokeWidth: 1.4,
    },
    label: {
      text: '',
      fill: '#ffffff',
      fontSize: 12,
      fontWeight: 600,
      fontFamily: 'system-ui, sans-serif',
      textAnchor: 'middle',
      textVerticalAnchor: 'top',
      x: 'calc(w/2)',
      y: 7,
    },
    nameLabel: {
      text: '',
      fill: '#ffffff',
      fontSize: 9,
      fontFamily: 'system-ui, sans-serif',
      textAnchor: 'middle',
      textVerticalAnchor: 'top',
      x: 'calc(w/2)',
      y: 22,
    },
  },
  ports: {
    groups: {
      in: {
        position: {
          name: 'line',
          args: { start: { x: 0, y: 36 }, end: { x: 0, y: 'calc(h-10)' } },
        },
        attrs: {
          circle: {
            magnet: 'passive',
            r: 7,
            fill: PORT_IN_IDLE,
            stroke: '#d5d8e6',
            strokeWidth: 1.5,
            cursor: 'crosshair',
          },
          text: {
            fill: '#f2f2f8',
            fontSize: 10,
            fontFamily: 'system-ui, sans-serif',
          },
        },
        label: { position: { name: 'right', args: { x: 12, y: 0 } } },
      },
      out: {
        position: {
          name: 'line',
          args: { start: { x: 'calc(w)', y: 36 }, end: { x: 'calc(w)', y: 'calc(h-10)' } },
        },
        attrs: {
          circle: {
            magnet: true,
            r: 7,
            fill: PORT_OUT_IDLE,
            stroke: '#d5d8e6',
            strokeWidth: 1.5,
            cursor: 'crosshair',
          },
          text: {
            fill: '#f2f2f8',
            fontSize: 10,
            fontFamily: 'system-ui, sans-serif',
          },
        },
        label: { position: { name: 'left', args: { x: -12, y: 0 } } },
      },
    },
  },
}, {
  markup: [
    { tagName: 'rect', selector: 'body' },
    { tagName: 'text', selector: 'label' },
    { tagName: 'text', selector: 'nameLabel' },
  ],
});

const cellNamespace = { ...shapes, sc: { Block } };

function foreground(hex) {
  const raw = String(hex || '').replace('#', '');
  if (raw.length !== 6) return '#ffffff';
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return '#ffffff';
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.72 ? '#1b1b1b' : '#ffffff';
}

function longest(pins) {
  return (pins || []).reduce((max, pin) => Math.max(max, String(pin).length), 0);
}

function blockSize(config, name) {
  const inputs = config.inputPins || [];
  const outputs = config.outputPins || [];
  const rows = Math.max(inputs.length, outputs.length, 1);
  const textW = (count) => Math.ceil(count * 6.6);
  const label = config.label || '';
  const width = Math.min(260, Math.max(
    112,
    36 + textW(longest(inputs)) + textW(longest(outputs)),
    textW(label.length) + 36,
    textW(String(name || '').length) + 28,
  ));
  const height = Math.max(64, 42 + rows * 18);
  return { width, height };
}

class VisualConstructor {
  constructor(containerEl, simEngine) {
    this.host = containerEl instanceof SVGSVGElement ? containerEl.parentElement : containerEl;
    if (!this.host) throw new Error('Нет контейнера канвы');
    this.engine = simEngine;
    this.elementViews = new Map();
    this._nextId = 1;
    this.selectedId = null;
    this._selectedLinkId = null;
    this._restoring = false;
    this._syncing = false;
    this._connSig = '';
    this.onEvent = null;

    this.graph = new dia.Graph({}, { cellNamespace });
    this.paper = new dia.Paper({
      el: this.host,
      model: this.graph,
      width: '100%',
      height: '100%',
      async: false,
      background: { color: '#0d0d1a' },
      gridSize: 10,
      drawGrid: { name: 'dot', args: { color: '#2a2a44', thickness: 1.4 } },
      cellViewNamespace: cellNamespace,
      snapLinks: { radius: 48 },
      snapLinksSelf: false,
      markAvailable: true,
      linkPinning: false,
      magnetThreshold: 2,
      defaultRouter: ROUTER,
      defaultConnector: CONNECTOR,
      defaultConnectionPoint: { name: 'boundary' },
      interactive: {
        linkMove: false,
        labelMove: false,
        vertexAdd: false,
        vertexMove: false,
        vertexRemove: false,
        arrowheadMove: false,
      },
      highlighting: {
        default: {
          name: 'stroke',
          options: { padding: 3, attrs: { stroke: '#ffeb3b', 'stroke-width': 2 } },
        },
        connecting: {
          name: 'stroke',
          options: { padding: 3, attrs: { stroke: ON_COLOR, 'stroke-width': 2 } },
        },
      },
      defaultLink: () => this._makeLink(),
      validateMagnet: (_cellView, magnet) => magnet?.getAttribute('port-group') === 'out',
      validateConnection: (cellViewS, magnetS, cellViewT, magnetT, _end, linkView) => (
        this._canConnect(cellViewS, magnetS, cellViewT, magnetT, linkView?.model)
      ),
      allowLink: (linkView) => this._linkAllowed(linkView.model),
    });

    this._bindPaper();
    this._bindGraph();
    this._bindGestures();
    this._observeHost();
  }

  /** Поджать бумагу под текущий размер панели. */
  relayout() {
    const box = this.host.parentElement || this.host;
    const width = Math.floor(box.clientWidth);
    const height = Math.floor(box.clientHeight);
    if (width < 2 || height < 2) return;
    if (this._paperWidth === width && this._paperHeight === height) return;
    this._paperWidth = width;
    this._paperHeight = height;
    this.paper.setDimensions(width, height);
  }

  _observeHost() {
    const box = this.host.parentElement || this.host;
    if (typeof ResizeObserver !== 'function') {
      this.relayout();
      return;
    }
    this._hostObserver = new ResizeObserver(() => this.relayout());
    this._hostObserver.observe(box);
    this.relayout();
  }

  /**
   * Сдвиг — перетаскивание пустого места, масштаб — колёсико или щипок.
   * Слушатели висят на бумаге, не на вкладке Dockview: долгое нажатие
   * для перетаскивания панели с канвой не пересекается.
   */
  _bindGestures() {
    this._pan = null;
    this._pointers = new Map();
    const surface = this.paper.el;

    this.paper.on('blank:pointerdown', (evt) => {
      this._clearLinkSelection();
      this.selectElement(null);
      if (this._pointers.size > 1) return;
      const translate = this.paper.translate();
      this._pan = {
        x: evt.clientX,
        y: evt.clientY,
        tx: translate.tx,
        ty: translate.ty,
        moved: false,
      };
    });
    this.paper.on('blank:pointermove', (evt) => {
      if (!this._pan || this._pointers.size > 1) return;
      const dx = evt.clientX - this._pan.x;
      const dy = evt.clientY - this._pan.y;
      if (!this._pan.moved && Math.hypot(dx, dy) < 4) return;
      this._pan.moved = true;
      this.paper.translate(this._pan.tx + dx, this._pan.ty + dy);
    });
    this.paper.on('blank:pointerup', () => {
      this._pan = null;
    });

    surface.addEventListener('wheel', (evt) => {
      evt.preventDefault();
      const current = this.paper.scale().sx || 1;
      const next = Math.min(2.5, Math.max(0.35, current * (evt.deltaY < 0 ? 1.08 : 0.92)));
      const local = this.paper.clientToLocalPoint(evt.clientX, evt.clientY);
      this.paper.scaleUniformAtPoint(next, local);
    }, { passive: false });

    const remember = (evt) => {
      if (evt.pointerType === 'mouse') return;
      this._pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      if (this._pointers.size === 2) {
        this._pan = null;
        this._pinch = this._pinchSnapshot();
      }
    };
    const forget = (evt) => {
      this._pointers.delete(evt.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
    };
    surface.addEventListener('pointerdown', remember);
    surface.addEventListener('pointerup', forget);
    surface.addEventListener('pointercancel', forget);
    surface.addEventListener('pointermove', (evt) => {
      if (evt.pointerType === 'mouse' || !this._pointers.has(evt.pointerId)) return;
      this._pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      if (this._pointers.size !== 2 || !this._pinch) return;
      evt.preventDefault();
      const [a, b] = [...this._pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (this._pinch.distance < 1) return;
      const next = Math.min(2.5, Math.max(0.35, this._pinch.scale * (distance / this._pinch.distance)));
      this.paper.scaleUniformAtPoint(next, this._pinch.local);
    }, { passive: false });
  }

  _pinchSnapshot() {
    const [a, b] = [...this._pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: this.paper.scale().sx || 1,
      local: this.paper.clientToLocalPoint(mid.x, mid.y),
    };
  }

  clientToLocal(clientX, clientY) {
    const point = this.paper.clientToLocalPoint(clientX, clientY);
    return { x: point.x, y: point.y };
  }

  _bindPaper() {
    this.paper.on('element:pointerdown', (view) => {
      const uid = view.model.get('uid');
      if (uid == null) return;
      this._clearLinkSelection();
      this.selectElement(uid);
    });
    this.paper.on('element:mouseenter', (view) => {
      this._mountElementTools(view.model);
    });
    this.paper.on('link:pointerdown', (view) => {
      this._selectLink(view.model);
    });
    this.paper.on('blank:pointerdown', () => {
      this._clearLinkSelection();
      this.selectElement(null);
    });
  }

  _bindGraph() {
    this.graph.on('change:position', (cell, position) => {
      if (!cell.isElement() || !position) return;
      const view = this.elementViews.get(String(cell.get('uid')));
      if (!view) return;
      view.x = position.x;
      view.y = position.y;
      if (!this._restoring) this._emit('element-moved', view.el);
    });
    this.graph.on('add', (cell) => {
      if (cell.isLink() && !this._restoring && this._directedEnds(cell)) this._syncConnections();
    });
    this.graph.on('change:source change:target', (cell) => {
      if (!cell.isLink() || this._restoring || this._syncing) return;
      if (this._directedEnds(cell) || this._isInvalidCompleted(cell)) this._syncConnections();
    });
    this.graph.on('remove', (cell) => {
      if (cell.isLink()) {
        if (this._selectedLinkId === cell.id) this._selectedLinkId = null;
        if (!this._restoring) this._syncConnections();
        return;
      }
      this._forgetElement(cell);
    });
  }

  _viewport() {
    const area = this.paper.getArea();
    return {
      width: area.width || this.host.clientWidth || 800,
      height: area.height || this.host.clientHeight || 600,
    };
  }

  _occupied() {
    return [...this.elementViews.values()].map((view) => ({
      x: view.x,
      y: view.y,
      width: view.width,
      height: view.height,
    }));
  }

  /**
   * Добавить блок.
   * x/y — желаемая точка. Если она занята, блок уезжает на свободное место.
   */
  addElement(type, x, y) {
    const prefer = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    return this._place(type, prefer, { fixed: false });
  }

  _place(type, prefer, { uid = null, fixed = false } = {}) {
    const config = GATES[type];
    if (!config) throw new Error(`Unknown element type: ${type}`);

    let name;
    let resolvedUid;
    if (uid == null) {
      name = `${config.label || type}_${this._nextId++}`;
      resolvedUid = String(this._nextId++);
    } else {
      resolvedUid = String(uid);
      name = `${config.label || type}_${resolvedUid}`;
    }

    const el = new LogicElement({ ...config, name, type });
    el.uid = resolvedUid;
    this.engine.addElement(el);

    const size = blockSize(config, name);
    const spot = fixed
      ? {
        x: Number.isFinite(prefer?.x) ? prefer.x : 40,
        y: Number.isFinite(prefer?.y) ? prefer.y : 40,
      }
      : findFreeTopLeft(this._occupied(), size.width, size.height, prefer, this._viewport());

    const fg = foreground(config.color);
    const cell = new Block({
      position: { x: spot.x, y: spot.y },
      size,
      z: 2,
      uid: resolvedUid,
      attrs: {
        body: { fill: config.color || '#333333' },
        label: { text: config.label || type, fill: fg },
        nameLabel: { text: name === (config.label || type) ? '' : name, fill: fg },
      },
    });
    cell.addPorts(this._ports(config, fg));

    const view = {
      el,
      type,
      uid: resolvedUid,
      x: spot.x,
      y: spot.y,
      width: size.width,
      height: size.height,
      cell,
    };
    this.elementViews.set(resolvedUid, view);
    this.graph.addCell(cell);
    this._mountElementTools(cell);

    if (!this._restoring) {
      this.updateStates();
      this._emit('element-placed', el);
    }
    return el;
  }

  _ports(config, fg) {
    const ports = [];
    for (const pin of config.inputPins || []) {
      ports.push({
        id: pin,
        group: 'in',
        attrs: { text: { text: pin, fill: fg }, labelText: { text: pin, fill: fg } },
      });
    }
    for (const pin of config.outputPins || []) {
      ports.push({
        id: pin,
        group: 'out',
        attrs: { text: { text: pin, fill: fg }, labelText: { text: pin, fill: fg } },
      });
    }
    return ports;
  }

  _mountElementTools(cell) {
    const jointView = this.paper.findViewByModel(cell);
    if (!jointView || jointView.hasTools('remove')) return;
    try {
      jointView.addTools(new dia.ToolsView({
        name: 'remove',
        tools: [new elementTools.Remove({
          x: '100%',
          y: 0,
          offset: { x: -16, y: 14 },
          useModelGeometry: true,
        })],
      }));
    } catch (error) {
      console.warn(error);
    }
  }

  _makeLink(fromCell, fromPin, toCell, toPin) {
    const link = new shapes.standard.Link({
      z: 1,
      router: ROUTER,
      connector: CONNECTOR,
      attrs: {
        line: {
          stroke: OFF_COLOR,
          strokeWidth: 2.4,
          targetMarker: {
            type: 'path',
            d: 'M 8 -4 0 0 8 4 z',
            fill: OFF_COLOR,
            stroke: 'none',
          },
        },
        wrapper: { strokeWidth: 16, cursor: 'pointer' },
      },
    });
    if (fromCell && fromPin) link.source({ id: fromCell.id, port: fromPin });
    if (toCell && toPin) link.target({ id: toCell.id, port: toPin });
    return link;
  }

  _portGroup(cell, portId) {
    return cell?.getPort?.(portId)?.group || null;
  }

  _directedEnds(link) {
    const src = link.get('source') || {};
    const tgt = link.get('target') || {};
    if (!src.id || !tgt.id || src.port == null || tgt.port == null) return null;
    const srcCell = this.graph.getCell(src.id);
    const tgtCell = this.graph.getCell(tgt.id);
    if (!srcCell?.isElement?.() || !tgtCell?.isElement?.() || srcCell === tgtCell) return null;
    const sourceGroup = this._portGroup(srcCell, src.port);
    const targetGroup = this._portGroup(tgtCell, tgt.port);
    if (sourceGroup === 'out' && targetGroup === 'in') {
      return { fromCell: srcCell, fromPin: src.port, toCell: tgtCell, toPin: tgt.port };
    }
    return null;
  }

  _isInvalidCompleted(link) {
    const src = link.get('source') || {};
    const tgt = link.get('target') || {};
    if (!src.id || !tgt.id || src.port == null || tgt.port == null) return false;
    return !this._directedEnds(link);
  }

  _canConnect(cellViewS, magnetS, cellViewT, magnetT, linkModel) {
    if (!magnetS || !magnetT || !cellViewS || !cellViewT) return false;
    if (magnetS === cellViewS.el || magnetT === cellViewT.el) return false;
    if (cellViewS.model === cellViewT.model) return false;
    const sourcePort = magnetS.getAttribute('port');
    const targetPort = magnetT.getAttribute('port');
    if (magnetS.getAttribute('port-group') !== 'out') return false;
    if (magnetT.getAttribute('port-group') !== 'in') return false;
    if (!sourcePort || !targetPort) return false;
    return !this._inputTaken(cellViewT.model, targetPort, linkModel);
  }

  _inputTaken(cell, portId, ignoreLink) {
    return this.graph.getConnectedLinks(cell, { inbound: true }).some((link) => {
      if (ignoreLink && link.id === ignoreLink.id) return false;
      const target = link.get('target');
      return target?.id === cell.id && target.port === portId;
    });
  }

  _linkAllowed(link) {
    const ends = this._directedEnds(link);
    if (!ends) return false;
    return !this._inputTaken(ends.toCell, ends.toPin, link);
  }

  _logicOf(cell) {
    if (!cell) return null;
    return this.elementViews.get(String(cell.get('uid')))?.el || null;
  }

  /** Собрать SimEngine.connections заново из рёбер графа. */
  _syncConnections() {
    if (this._restoring || this._syncing) return;
    this._syncing = true;
    const drop = [];
    const next = [];
    const seenInputs = new Set();
    try {
      for (const link of this.graph.getLinks()) {
        const ends = this._directedEnds(link);
        if (!ends) {
          if (this._isInvalidCompleted(link)) drop.push(link);
          continue;
        }
        const key = `${ends.toCell.id}:${ends.toPin}`;
        if (seenInputs.has(key)) {
          drop.push(link);
          continue;
        }
        seenInputs.add(key);
        const fromEl = this._logicOf(ends.fromCell);
        const toEl = this._logicOf(ends.toCell);
        if (!fromEl || !toEl) continue;
        next.push({
          fromEl,
          fromPin: ends.fromPin,
          toEl,
          toPin: ends.toPin,
        });
        toEl.inputs[ends.toPin] = fromEl.outputs[ends.fromPin] ?? 0;
      }
      for (const link of drop) link.remove();
    } finally {
      this._syncing = false;
    }
    const signature = next
      .map((item) => `${item.fromEl.uid}:${item.fromPin}>${item.toEl.uid}:${item.toPin}`)
      .join('|');
    this.engine.connections = next;
    if (signature === this._connSig) return;
    this._connSig = signature;
    this.engine._emit('connected', {});
    this.updateStates();
  }

  _wireSpecs() {
    const specs = [];
    for (const link of this.graph.getLinks()) {
      const ends = this._directedEnds(link);
      if (!ends) continue;
      specs.push({
        fromUid: String(ends.fromCell.get('uid')),
        fromPin: ends.fromPin,
        toUid: String(ends.toCell.get('uid')),
        toPin: ends.toPin,
      });
    }
    return specs;
  }

  _emit(event, data) {
    if (this.onEvent) this.onEvent(event, data);
  }

  selectElement(id) {
    const next = id == null ? null : String(id);
    if (!this.elementViews.has(next) && next != null) return;
    if (this.selectedId === next) {
      this._paintSelection();
      return;
    }
    this.selectedId = next;
    this._paintSelection();
    this._emit('element-selected', next ? this.elementViews.get(next)?.el ?? null : null);
  }

  _clearLinkSelection() {
    if (!this._selectedLinkId) return;
    const previous = this.graph.getCell(this._selectedLinkId);
    const previousView = previous && this.paper.findViewByModel(previous);
    previousView?.removeTools();
    this._selectedLinkId = null;
    this._paintSelection();
  }

  _selectLink(link) {
    if (!link) {
      this._clearLinkSelection();
      return;
    }
    if (this._selectedLinkId !== link.id) this._clearLinkSelection();
    const hadElement = this.selectedId != null;
    this.selectedId = null;
    this._selectedLinkId = link.id;
    const jointView = this.paper.findViewByModel(link);
    if (jointView && !jointView.hasTools('remove')) {
      jointView.addTools(new dia.ToolsView({
        name: 'remove',
        tools: [new linkTools.Remove({ distance: 36, offset: 0 })],
      }));
    }
    this._paintSelection();
    if (hadElement) this._emit('element-selected', null);
  }

  _paintSelection() {
    for (const view of this.elementViews.values()) {
      const on = view.uid === this.selectedId;
      view.cell.attr({
        body: {
          stroke: on ? '#ffeb3b' : '#c5c8d6',
          strokeWidth: on ? 2.6 : 1.4,
        },
      });
    }
    for (const link of this.graph.getLinks()) {
      link.attr('line/strokeWidth', link.id === this._selectedLinkId ? 3.6 : 2.4);
    }
  }

  _forgetElement(cell) {
    const uid = String(cell.get('uid') ?? '');
    const view = this.elementViews.get(uid);
    if (!view) return;
    this.elementViews.delete(uid);
    if (this._restoring) return;
    try { view.el.dispose(); } catch (error) { console.warn(error); }
    this.engine.elements = this.engine.elements.filter((item) => item !== view.el);
    if (this.selectedId === uid) {
      this.selectedId = null;
      this._emit('element-selected', null);
    }
    this._emit('element-deleted', view.el);
  }

  deleteElement(id) {
    const view = this.elementViews.get(String(id));
    if (!view) return false;
    view.cell.remove();
    return true;
  }

  /** Удалить выделенный провод или блок. Возвращает 'link' | 'element' | null. */
  deleteSelection() {
    if (this._selectedLinkId) {
      const link = this.graph.getCell(this._selectedLinkId);
      if (link) {
        link.remove();
        return 'link';
      }
      this._selectedLinkId = null;
    }
    if (this.selectedId && this.deleteElement(this.selectedId)) return 'element';
    return null;
  }

  _caption(view, config) {
    const label = config?.label || view.type;
    const name = view.el?.name || '';
    if (!name || name === label) return '';
    return name;
  }

  /** Обновить подпись и размер после того, как компилятор переименовал блок. */
  _renderElement(view) {
    if (!view?.cell) return;
    const config = GATES[view.type] || {};
    const width = Math.max(48, view.width || 112);
    const height = Math.max(40, view.height || 64);
    view.width = width;
    view.height = height;
    view.cell.resize(width, height);
    const fg = foreground(config.color);
    view.cell.attr({
      body: { fill: config.color || '#673AB7' },
      label: { text: config.label || view.type, fill: fg },
      nameLabel: { text: this._caption(view, config), fill: fg },
    });
    this._paintSelection();
  }

  updateStates() {
    for (const view of this.elementViews.values()) {
      const el = view.el;
      for (const pin of el.inputPins) {
        view.cell.portProp(pin, 'attrs/circle/fill', el.inputs[pin] ? ON_COLOR : PORT_IN_IDLE);
      }
      for (const pin of el.outputPins) {
        view.cell.portProp(pin, 'attrs/circle/fill', el.outputs[pin] ? ON_COLOR : PORT_OUT_IDLE);
      }
    }
    for (const link of this.graph.getLinks()) this._paintLink(link);
    this._paintSelection();
  }

  _paintLink(link) {
    const ends = this._directedEnds(link);
    if (!ends) return;
    const fromEl = this._logicOf(ends.fromCell);
    const bit = fromEl?.outputs[ends.fromPin] ? 1 : 0;
    if (link.get('signal') === bit) return;
    link.set('signal', bit, { silent: true });
    const stroke = bit ? ON_COLOR : OFF_COLOR;
    link.attr({
      line: {
        stroke,
        targetMarker: {
          type: 'path',
          d: 'M 8 -4 0 0 8 4 z',
          fill: stroke,
          stroke: 'none',
        },
      },
    });
    link.labels([{
      position: { distance: 0.55 },
      attrs: {
        text: {
          text: bit ? '1' : '0',
          fill: bit ? '#062033' : '#e7edf5',
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontWeight: '700',
          pointerEvents: 'none',
        },
        rect: {
          fill: bit ? ON_COLOR : '#1b2230',
          stroke,
          strokeWidth: 1,
          rx: 3,
          ry: 3,
          pointerEvents: 'none',
        },
      },
    }]);
  }

  serialize() {
    const gates = {};
    for (const view of this.elementViews.values()) {
      if (isBuiltinType(view.type) || gates[view.type]) continue;
      const config = GATES[view.type];
      if (!config) continue;
      gates[view.type] = {
        label: config.label,
        inputPins: [...config.inputPins],
        outputPins: [...config.outputPins],
        color: config.color,
        ...(config.autorun ? { autorun: true } : {}),
      };
    }
    return {
      nextId: this._nextId,
      elements: [...this.elementViews.values()].map((view) => ({
        uid: view.uid,
        type: view.type,
        x: view.x,
        y: view.y,
      })),
      links: this._wireSpecs(),
      gates,
    };
  }

  _resetCanvas() {
    this._restoring = true;
    for (const view of this.elementViews.values()) {
      try { view.el.dispose(); } catch (error) { console.warn(error); }
    }
    this.elementViews.clear();
    this.engine.elements = [];
    this.engine.connections = [];
    this.selectedId = null;
    this._selectedLinkId = null;
    this._connSig = '';
    this.graph.clear();
    this._restoring = false;
  }

  deserialize(state) {
    this._resetCanvas();
    this._restoring = true;
    this._nextId = state?.nextId || 1;
    try {
      for (const element of state?.elements || []) {
        if (!element || !GATES[element.type]) {
          console.warn('Пропуск неизвестного элемента', element?.type);
          continue;
        }
        this._place(element.type, { x: element.x, y: element.y }, { uid: element.uid, fixed: true });
      }
    } finally {
      this._restoring = false;
    }
    let maxUid = 0;
    for (const view of this.elementViews.values()) {
      const numeric = Number(view.uid);
      if (Number.isFinite(numeric)) maxUid = Math.max(maxUid, numeric);
    }
    if (this._nextId <= maxUid) this._nextId = maxUid + 1;
    return true;
  }

  /**
   * Восстановить провода.
   * Старый формат и новый — один и тот же список { fromUid, fromPin, toUid, toPin }.
   * Битые рёбра (нет блока, чужой пин, петля, второй источник на вход) пропускаются.
   */
  restoreWires(wires) {
    this._restoring = true;
    try {
      for (const spec of wires || []) {
        if (!spec) continue;
        const fromView = this.elementViews.get(String(spec.fromUid));
        const toView = this.elementViews.get(String(spec.toUid));
        if (!fromView || !toView || fromView === toView) continue;
        if (!fromView.el.outputPins.includes(spec.fromPin)) continue;
        if (!toView.el.inputPins.includes(spec.toPin)) continue;
        if (this._inputTaken(toView.cell, spec.toPin)) continue;
        this.graph.addCell(this._makeLink(fromView.cell, spec.fromPin, toView.cell, spec.toPin));
      }
    } finally {
      this._restoring = false;
    }
    this._syncConnections();
    this.updateStates();
  }
}

export { VisualConstructor };

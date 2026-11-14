/**
 * Визуальный конструктор — SVG-based canvas для размещения и соединения элементов.
 */
import { GATES, LogicElement } from './elements.js';

class VisualConstructor {
  constructor(containerEl, simEngine) {
    this.container = containerEl;
    this.engine = simEngine;
    this.svg = null;
    this.elementViews = new Map();  // el → SVG group
    this._nextId = 1;
    this._dragging = null;
    this._connecting = null;       // { el, pin, isInput }
    this._hoveredPin = null;
    this._wirePreview = null;
    this.selectedId = null;        // выделенный элемент

    this._initSVG();
    this._initEvents();
  }

  _initSVG() {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    this.svg.style.background = '#0d0d1a';
    this.svg.style.borderRadius = '12px';
    this.svg.style.cursor = 'default';
    this.container.appendChild(this.svg);
  }

  _initEvents() {
    this.svg.addEventListener('mousedown', (e) => {
      const target = e.target.closest('[data-el-id]');
      if (!target) {
        // Отпускаем соединение если тащим
        if (this._connecting) this._cancelConnect();
        return;
      }
      const id = target.dataset.elId;
      const el = this.elementViews.get(id)?.el;
      if (!el) return;

      // Кнопка удаления
      if (e.target.closest('[data-del-btn]')) {
        this.deleteElement(id);
        return;
      }

      // Определяем — пином или телом элемента кликнули
      const pinEl = e.target.closest('[data-pin]');
      if (pinEl) {
        const pin = pinEl.dataset.pin;
        const isInput = pinEl.classList.contains('pin-input');
        this._startConnect(el, pin, isInput, e);
        return;
      }

      // Выделение элемента
      this.selectElement(id);

      // Перетаскивание элемента
      this._dragging = { el, id, offsetX: e.offsetX, offsetY: e.offsetY };
      const view = this.elementViews.get(id);
      view.element.style.cursor = 'grabbing';
      e.preventDefault();
    });

    this.svg.addEventListener('mousemove', (e) => {
      if (this._dragging) {
        const rect = this.svg.getBoundingClientRect();
        const x = e.clientX - rect.left - this._dragging.offsetX;
        const y = e.clientY - rect.top - this._dragging.offsetY;
        const view = this.elementViews.get(this._dragging.id);
        if (view) {
          view.x = Math.max(0, x);
          view.y = Math.max(0, y);
          this._renderElement(view);
          this._redrawWires();
          this._emit('element-moved', view.el);
        }
      }
      if (this._connecting) {
        this._updateWirePreview(e);
      }
    });

    this.svg.addEventListener('mouseup', () => {
      if (this._dragging) {
        const view = this.elementViews.get(this._dragging.id);
        if (view) view.element.style.cursor = 'grab';
        this._dragging = null;
      }
      // Завершение соединения
      if (this._connecting) {
        const hovered = this._hoveredPin;
        if (hovered && hovered.el !== this._connecting.el) {
          // Проверяем совместимость: input → output или output → input
          if (this._connecting.isInput && !hovered.isInput) {
            this._finishConnect(this._connecting.el, this._connecting.pin, hovered.el, hovered.pin);
          } else if (!this._connecting.isInput && hovered.isInput) {
            this._finishConnect(this._connecting.el, this._connecting.pin, hovered.el, hovered.pin);
          } else {
            this._cancelConnect();
          }
        } else {
          this._cancelConnect();
        }
      }
    });
  }

  _getPinPos(el, pin) {
    const view = this.elementViews.get(el.uid);
    if (!view) return null;
    const config = GATES[el.type];
    if (!config) return null;
    const inputIdx = config.inputPins.indexOf(pin);
    const outputIdx = config.outputPins.indexOf(pin);

    const bx = view.x, by = view.y, bw = view.width, bh = view.height;
    const pinSpacing = 18;

    if (inputIdx >= 0) {
      return { x: bx, y: by + 24 + inputIdx * pinSpacing };
    }
    if (outputIdx >= 0) {
      return { x: bx + bw, y: by + 24 + outputIdx * pinSpacing };
    }
    return null;
  }

  _startConnect(el, pin, isInput, e) {
    this._connecting = { el, pin, isInput };
    // Создаём линию-превью
    this._wirePreview = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this._wirePreview.setAttribute('stroke', '#4fc3f7');
    this._wirePreview.setAttribute('stroke-width', '2');
    this._wirePreview.setAttribute('stroke-dasharray', '5,3');
    this._wirePreview.setAttribute('opacity', '0.6');
    this.svg.appendChild(this._wirePreview);
    this._updateWirePreview(e);
  }

  _updateWirePreview(e) {
    if (!this._wirePreview || !this._connecting) return;
    const rect = this.svg.getBoundingClientRect();
    const pos = this._getPinPos(this._connecting.el, this._connecting.pin);
    if (pos) {
      this._wirePreview.setAttribute('x1', pos.x);
      this._wirePreview.setAttribute('y1', pos.y);
      this._wirePreview.setAttribute('x2', e.clientX - rect.left);
      this._wirePreview.setAttribute('y2', e.clientY - rect.top);
    }
  }

  _cancelConnect() {
    if (this._wirePreview) { this._wirePreview.remove(); this._wirePreview = null; }
    this._connecting = null;
    this._hoveredPin = null;
  }

  _finishConnect(fromEl, fromPin, toEl, toPin) {
    this.engine.connect(fromEl, fromPin, toEl, toPin);
    this._cancelConnect();
    this._redrawWires();
  }

  /** Добавить элемент на канву */
  addElement(type, x, y) {
    const config = GATES[type];
    if (!config) throw new Error(`Unknown element type: ${type}`);

    const el = new LogicElement({ ...config, name: `${config.label}_${this._nextId++}`, type });
    this.engine.addElement(el);

    const uid = String(this._nextId++);
    el.uid = uid;

    const view = {
      el, type, uid, x: x || 120, y: y || 80,
      width: 90, height: 40 + Math.max(config.inputPins.length, config.outputPins.length) * 18,
      element: null,
    };
    this.elementViews.set(uid, view);

    // Создаём SVG group
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.elId = uid;
    g.style.cursor = 'grab';
    view.element = g;
    this.svg.appendChild(g);

    this._renderElement(view);
    this._emit('element-placed', el);

    return el;
  }

  _renderElement(view) {
    const g = view.element;
    g.innerHTML = '';
    const bw = view.width, bh = view.height;
    const config = GATES[view.type];

    // Прямоугольник
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', view.x);
    rect.setAttribute('y', view.y);
    rect.setAttribute('width', bw);
    rect.setAttribute('height', bh);
    rect.setAttribute('rx', '8');
    rect.setAttribute('fill', config.color || '#333');
    rect.setAttribute('stroke', '#555');
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);

    // Лейбл
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', view.x + bw / 2);
    label.setAttribute('y', view.y + 18);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', '#fff');
    label.setAttribute('font-size', '11');
    label.setAttribute('font-weight', '600');
    label.textContent = config.label || view.type;
    g.appendChild(label);

    // Кнопка удаления «×»
    const delBtn = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    delBtn.setAttribute('x', view.x + bw - 10);
    delBtn.setAttribute('y', view.y + 12);
    delBtn.setAttribute('text-anchor', 'middle');
    delBtn.setAttribute('fill', '#ff6b6b');
    delBtn.setAttribute('font-size', '13');
    delBtn.setAttribute('font-weight', '700');
    delBtn.style.cursor = 'pointer';
    delBtn.style.opacity = '0.6';
    delBtn.textContent = '×';
    delBtn.dataset.delBtn = '';
    g.appendChild(delBtn);

    // Имя (мелко)
    const nameText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nameText.setAttribute('x', view.x + bw / 2);
    nameText.setAttribute('y', view.y + bh - 6);
    nameText.setAttribute('text-anchor', 'middle');
    nameText.setAttribute('fill', '#888');
    nameText.setAttribute('font-size', '8');
    nameText.textContent = view.el.name;
    g.appendChild(nameText);

    // Input pins
    const pinSpacing = 18;
    config.inputPins.forEach((pin, i) => {
      const px = view.x;
      const py = view.y + 24 + i * pinSpacing;
      this._createPin(g, pin, px, py, true, view);
    });

    // Output pins
    config.outputPins.forEach((pin, i) => {
      const px = view.x + bw;
      const py = view.y + 24 + i * pinSpacing;
      this._createPin(g, pin, px, py, false, view);
    });
  }

  _createPin(g, name, x, y, isInput, view) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', isInput ? '#2a2a4a' : '#4fc3f7');
    circle.setAttribute('stroke', '#888');
    circle.setAttribute('stroke-width', '1');
    circle.dataset.pin = name;
    circle.classList.add(isInput ? 'pin-input' : 'pin-output');
    g.appendChild(circle);

    // Метка пина (мелко)
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', isInput ? x + 10 : x - 10);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', isInput ? 'start' : 'end');
    label.setAttribute('fill', '#aaa');
    label.setAttribute('font-size', '8');
    label.textContent = name;
    g.appendChild(label);

    // Слушатели для пина
    circle.addEventListener('mouseenter', () => {
      this._hoveredPin = { el: view.el, pin: name, isInput };
    });
    circle.addEventListener('mouseleave', () => {
      this._hoveredPin = null;
    });
  }

  _redrawWires() {
    // Удаляем старые линии
    this.svg.querySelectorAll('.wire-line').forEach(l => l.remove());

    for (const c of this.engine.connections) {
      const fromPos = this._getPinPos(c.fromEl, c.fromPin);
      const toPos   = this._getPinPos(c.toEl, c.toPin);
      if (!fromPos || !toPos) continue;

      const val = c.fromEl.outputs[c.fromPin] ?? 0;
      const color = val ? '#4fc3f7' : '#333';
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.classList.add('wire-line');

      // Линия с изгибом
      const midX = (fromPos.x + toPos.x) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = `M ${fromPos.x} ${fromPos.y} C ${midX} ${fromPos.y}, ${midX} ${toPos.y}, ${toPos.x} ${toPos.y}`;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('opacity', '0.8');
      group.appendChild(path);
      this.svg.appendChild(group);
    }
  }

  _emit(event, data) {
    // Уведомление слушателей (пока простой callback)
    if (this.onEvent) this.onEvent(event, data);
  }

  /** Выделить элемент */
  selectElement(id) {
    // Снять выделение с предыдущего
    if (this.selectedId && this.elementViews.has(this.selectedId)) {
      this._setSelected(this.selectedId, false);
    }
    this.selectedId = id;
    if (id && this.elementViews.has(id)) {
      this._setSelected(id, true);
    }
  }

  _setSelected(id, on) {
    const view = this.elementViews.get(id);
    if (!view) return;
    const rect = view.element.querySelector('rect');
    if (rect) {
      rect.setAttribute('stroke', on ? '#ffeb3b' : '#555');
      rect.setAttribute('stroke-width', on ? '2.5' : '1.5');
    }
  }

  /** Удалить элемент */
  deleteElement(id) {
    const view = this.elementViews.get(id);
    if (!view) return;
    // Удаляем соединения, связанные с этим элементом
    this.engine.connections = this.engine.connections.filter(c =>
      c.fromEl !== view.el && c.toEl !== view.el
    );
    // Удаляем элемент из симуляции
    this.engine.elements = this.engine.elements.filter(e => e !== view.el);
    // Удаляем из map и svg
    this.elementViews.delete(id);
    view.element.remove();
    if (this.selectedId === id) this.selectedId = null;
    this._redrawWires();
    this._emit('element-deleted', view.el);
  }

  /** Обновить визуализацию состояний */
  updateStates() {
    for (const [uid, view] of this.elementViews) {
      const el = view.el;
      const config = GATES[el.type];
      if (!config) continue;
      // Обновляем цвета выходных пинов
      const g = view.element;
      const circles = g.querySelectorAll('.pin-output');
      for (const c of circles) {
        const pinName = c.dataset.pin;
        const val = el.outputs[pinName] ?? 0;
        c.setAttribute('fill', val ? '#4fc3f7' : '#555');
      }
    }
    this._redrawWires();
  }

  /** Сериализация схемы (элементы + позиции) */
  serialize() {
    return {
      nextId: this._nextId,
      elements: Array.from(this.elementViews.values()).map(v => ({
        uid: v.uid,
        type: v.type,
        x: v.x,
        y: v.y,
      })),
    };
  }

  /** Восстановление схемы из сохранённого состояния */
  deserialize(state) {
    // Очищаем текущую схему
    for (const [uid, view] of [...this.elementViews]) {
      view.element.remove();
      this.elementViews.delete(uid);
    }
    this.engine.elements = [];
    this.engine.connections = [];
    this.selectedId = null;
    this._nextId = state.nextId || 1;

    // Создаём элементы
    for (const ed of state.elements) {
      const el = new LogicElement({
        ...GATES[ed.type],
        name: `${GATES[ed.type]?.label || ed.type}_${ed.uid}`,
        type: ed.type,
      });
      this.engine.addElement(el);
      el.uid = ed.uid;

      const view = {
        el, type: ed.type, uid: ed.uid,
        x: ed.x || 120, y: ed.y || 80,
        width: 90,
        height: 40 + Math.max(
          (GATES[ed.type]?.inputPins?.length || 0),
          (GATES[ed.type]?.outputPins?.length || 0)
        ) * 18,
        element: null,
      };
      this.elementViews.set(ed.uid, view);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.dataset.elId = ed.uid;
      g.style.cursor = 'grab';
      view.element = g;
      this.svg.appendChild(g);
      this._renderElement(view);
    }

    return true;
  }
}

export { VisualConstructor };
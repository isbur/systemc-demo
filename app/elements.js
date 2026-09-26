/**
 * Библиотека готовых элементов и симуляционное ядро.
 * Теперь с визуальным Clock-элементом и детекцией фронта по пинам.
 */

// ─── Ядро симуляции ──────────────────────────────────────────────────────────

class SimEngine {
  constructor() {
    this.elements = [];
    this.connections = [];
    this.clockPeriod = 10;
    this.running = false;
    this.time = 0;
    this.cycle = 0;
    this.trace = [];
    this.maxTrace = 100;
    this.listeners = {};
    this._timer = null;
  }

  on(event, fn) {
    (this.listeners[event] ??= []).push(fn);
  }

  _emit(event, data) {
    for (const fn of (this.listeners[event] ?? [])) fn(data);
  }

  addElement(el) {
    this.elements.push(el);
    this._emit('element-added', el);
    return el;
  }

  connect(fromEl, fromPin, toEl, toPin) {
    this.connections.push({ fromEl, fromPin, toEl, toPin });
    const val = fromEl.outputs[fromPin] ?? 0;
    toEl.inputs[toPin] = val;
    this._emit('connected', { fromEl, fromPin, toEl, toPin });
  }

  getConnectionsFor(el) {
    return {
      inputs: this.connections.filter(c => c.toEl === el),
      outputs: this.connections.filter(c => c.fromEl === el),
    };
  }

  resetAll() {
    for (const el of this.elements) el.reset();
    for (const c of this.connections) {
      c.toEl.inputs[c.toPin] = c.fromEl.outputs[c.fromPin] ?? 0;
    }
    this.time = 0;
    this.cycle = 0;
    this.trace = [];
    this._emit('reset');
  }

  /** Один шаг симуляции: Clock-элементы переключаются, дельта-циклы */
  step() {
    this.cycle++;
    this.time += this.clockPeriod;

    // 1. Сохраняем предыдущие входы для всех (нужно для детекции фронта)
    for (const el of this.elements) {
      el._prevInputs = { ...el.inputs };
    }

    // 2. Обновляем Clock-элементы — они переключают свой выход
    for (const el of this.elements) {
      if (el._isClock) {
        el.evaluate();
      }
    }

    // 3. Пропагируем изменения от Clock-элементов
    for (const c of this.connections) {
      if (c.fromEl._isClock) {
        c.toEl.inputs[c.toPin] = c.fromEl.outputs[c.fromPin] ?? 0;
      }
    }

    // 4. Дельта-циклы — ВСЕ элементы вычисляются (sequential — через evaluate
    //    с детекцией фронта по своему пину clk)
    let changed = true;
    let maxDelta = 20;
    while (changed && maxDelta-- > 0) {
      changed = false;
      for (const el of this.elements) {
        const result = el.evaluate();
        if (result.changed) {
          changed = true;
          for (const c of this.connections) {
            if (c.fromEl === el) {
              c.toEl.inputs[c.toPin] = c.fromEl.outputs[c.fromPin] ?? 0;
            }
          }
        }
      }
    }

    // 5. Трейс
    const snapshot = {};
    for (const el of this.elements) {
      snapshot[el.name] = { ...el.outputs };
    }
    this.trace.push({ cycle: this.cycle, time: this.time, snapshot });
    if (this.trace.length > this.maxTrace) this.trace.shift();

    this._emit('step', { cycle: this.cycle, time: this.time, elements: this.elements });
    return snapshot;
  }

  start(intervalMs = 100) {
    if (this.running) return;
    this.running = true;
    this._emit('start');
    const stepFn = () => {
      if (!this.running) return;
      this.step();
      this._timer = setTimeout(stepFn, intervalMs);
    };
    this._timer = setTimeout(stepFn, intervalMs);
  }

  stop() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._emit('stop');
  }

  serializeConnections() {
    return this.connections.map(c => ({
      fromUid: c.fromEl.uid, fromPin: c.fromPin,
      toUid: c.toEl.uid, toPin: c.toPin,
    }));
  }

  deserializeConnections(conns, elementByUid) {
    for (const cd of conns) {
      const fromEl = elementByUid(cd.fromUid);
      const toEl = elementByUid(cd.toUid);
      if (fromEl && toEl) this.connect(fromEl, cd.fromPin, toEl, cd.toPin);
    }
  }
}

// ─── Базовый класс элемента ──────────────────────────────────────────────────

class LogicElement {
  constructor(config) {
    this.name = config.name || 'unnamed';
    this.type = config.type || 'custom';
    this.inputs = {};
    this.outputs = {};
    this.state = {};
    this._prevOutputs = {};
    this._prevInputs = {};
    this.inputPins = config.inputPins || [];
    this.outputPins = config.outputPins || [];

    // Инициализация портов
    for (const pin of this.inputPins) this.inputs[pin] = 0;
    for (const pin of this.outputPins) this.outputs[pin] = 0;
    for (const [k, v] of Object.entries(config.initialState || {})) this.state[k] = v;

    if (config.evaluate) this._evaluateFn = config.evaluate;
    if (config.reset) this._resetFn = config.reset;
    if (config.isClock) this._isClock = true;
  }

  /** Проверить, был ли на пине rising edge */
  _rising(pin) {
    const prev = this._prevInputs[pin] ?? 0;
    return prev === 0 && this.inputs[pin] === 1;
  }

  /** Проверить, был ли на пине falling edge */
  _falling(pin) {
    const prev = this._prevInputs[pin] ?? 0;
    return prev === 1 && this.inputs[pin] === 0;
  }

  evaluate() {
    const old = { ...this.outputs };
    if (this._evaluateFn) {
      this._evaluateFn(this.inputs, this.outputs, this.state);
    }
    const changed = Object.keys(this.outputs).some(k => this.outputs[k] !== old[k]);
    if (changed) this._prevOutputs = old;
    return { changed };
  }

  reset() {
    for (const k of Object.keys(this.inputs)) this.inputs[k] = 0;
    for (const k of Object.keys(this.outputs)) this.outputs[k] = 0;
    if (this._resetFn) this._resetFn(this.state);
    this._prevInputs = {};
  }
}

// ─── Фабрика готовых элементов ───────────────────────────────────────────────

const GATES = {};

function defineElement(type, config) {
  GATES[type] = config;
}

// ═══ Clock ══════════════════════════════════════════════════════════════════
// Единственный источник тактового сигнала. При каждом step() переключает clk.
defineElement('CLOCK', {
  label: 'Clock',
  inputPins: [],
  outputPins: ['clk'],
  color: '#FF5722',
  isClock: true,
  initialState: { phase: 0 },
  evaluate: (inp, out, state) => {
    state.phase = 1 - state.phase;  // toggle each step
    out.clk = state.phase;
  },
  reset: (state) => { state.phase = 0; },
});

// ═══ Константы (VCC = 1, GND = 0) ═══════════════════════════════════════════
defineElement('VCC', {
  label: 'VCC', inputPins: [], outputPins: ['y'],
  color: '#FFD600', evaluate: (inp, out) => { out.y = 1; }
});
defineElement('GND', {
  label: 'GND', inputPins: [], outputPins: ['y'],
  color: '#333', evaluate: (inp, out) => { out.y = 0; }
});

// ═══ Базовые вентили (combinatorial) ═══════════════════════════════════════

defineElement('AND', {
  label: 'AND', inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#4CAF50', evaluate: (inp, out) => { out.y = inp.a & inp.b; }
});
defineElement('OR', {
  label: 'OR', inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#FF9800', evaluate: (inp, out) => { out.y = inp.a | inp.b; }
});
defineElement('NOT', {
  label: 'NOT', inputPins: ['a'], outputPins: ['y'],
  color: '#F44336', evaluate: (inp, out) => { out.y = inp.a ? 0 : 1; }
});
defineElement('NAND', {
  label: 'NAND', inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#607D8B', evaluate: (inp, out) => { out.y = (inp.a & inp.b) ? 0 : 1; }
});
defineElement('NOR', {
  label: 'NOR', inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#9C27B0', evaluate: (inp, out) => { out.y = (inp.a | inp.b) ? 0 : 1; }
});
defineElement('XOR', {
  label: 'XOR', inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#00BCD4', evaluate: (inp, out) => { out.y = inp.a ^ inp.b; }
});

// ═══ D-триггер ══════════════════════════════════════════════════════════════
// clk — подключается к выходу Clock-элемента.
// Детекция rising edge через _rising('clk')
defineElement('DFF', {
  label: 'D-FF', inputPins: ['clk', 'd', 'rst_n'], outputPins: ['q', 'qn'],
  color: '#3F51B5',
  initialState: { qval: 0 },
  evaluate: (inp, out, state) => {
    // сброс приоритетнее всего
    if (inp.rst_n === 0) { state.qval = 0; }
    // rising edge на clk
    else if (inp._prevInputs?.clk === 0 && inp.clk === 1) {
      state.qval = inp.d;
    }
    out.q = state.qval;
    out.qn = state.qval ? 0 : 1;
  },
  reset: (state) => { state.qval = 0; }
});

// ═══ 4-битный кольцевой регистр ════════════════════════════════════════════
defineElement('RING4', {
  label: 'Ring Ctr', inputPins: ['clk', 'rst_n', 'enable'], outputPins: ['q0', 'q1', 'q2', 'q3'],
  color: '#E91E63',
  initialState: { reg: 0b0001 },
  evaluate: (inp, out, state) => {
    if (inp.rst_n === 0) { state.reg = 0b0001; }
    else if (inp._prevInputs?.clk === 0 && inp.clk === 1) {
      if (inp.enable) {
        const msb = (state.reg >> 3) & 1;
        state.reg = ((state.reg << 1) | msb) & 0xF;
      }
    }
    out.q0 = (state.reg >> 0) & 1;
    out.q1 = (state.reg >> 1) & 1;
    out.q2 = (state.reg >> 2) & 1;
    out.q3 = (state.reg >> 3) & 1;
  },
  reset: (state) => { state.reg = 0b0001; }
});

// ═══ 4-битный счётчик ════════════════════════════════════════════════════════
defineElement('COUNTER4', {
  label: 'Counter', inputPins: ['clk', 'rst_n', 'enable'], outputPins: ['q0', 'q1', 'q2', 'q3'],
  color: '#009688',
  initialState: { val: 0 },
  evaluate: (inp, out, state) => {
    if (inp.rst_n === 0) { state.val = 0; }
    else if (inp._prevInputs?.clk === 0 && inp.clk === 1) {
      if (inp.enable) { state.val = (state.val + 1) & 0xF; }
    }
    out.q0 = (state.val >> 0) & 1;
    out.q1 = (state.val >> 1) & 1;
    out.q2 = (state.val >> 2) & 1;
    out.q3 = (state.val >> 3) & 1;
  },
  reset: (state) => { state.val = 0; }
});

// ═══ Мультиплексоры ══════════════════════════════════════════════════════════
defineElement('MUX2', {
  label: 'MUX 2→1', inputPins: ['sel', 'a', 'b'], outputPins: ['y'],
  color: '#795548', evaluate: (inp, out) => { out.y = inp.sel ? inp.b : inp.a; }
});
defineElement('MUX4', {
  label: 'MUX 4→1', inputPins: ['s0', 's1', 'a', 'b', 'c', 'd'], outputPins: ['y'],
  color: '#8D6E63', evaluate: (inp, out) => {
    const sel = (inp.s1 << 1) | inp.s0;
    out.y = [inp.a, inp.b, inp.c, inp.d][sel] ?? 0;
  }
});

// ═══ Полусумматор ═════════════════════════════════════════════════════════════
defineElement('HALF_ADDER', {
  label: 'Half Add', inputPins: ['a', 'b'], outputPins: ['sum', 'carry'],
  color: '#FF5722', evaluate: (inp, out) => {
    out.sum = inp.a ^ inp.b;
    out.carry = inp.a & inp.b;
  }
});

// Экспорт
export { SimEngine, LogicElement, GATES, defineElement };
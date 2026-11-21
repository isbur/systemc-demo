/**
 * Библиотека готовых элементов.
 * Схема канвы — один процесс SystemC: шаг двигает общее sc_time.
 */
import { isCircuitElement } from './netlist.js';

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
    this._host = null;
    this._faulted = false;
  }

  attachHost(host) {
    this._host = host;
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
    if (!fromEl.outputPins.includes(fromPin) || !toEl.inputPins.includes(toPin)) return;
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

  async resetAll() {
    const restart = this.running;
    if (this.running) this.stop();
    this._faulted = false;
    this.cycle = 0;
    this.trace = [];
    try {
      if (this._host && this._circuitElements().length) await this._host.reset(this);
      else this.time = 0;
      for (const el of this.elements) {
        if (el._autorun) await el.reset();
      }
    } catch (error) {
      this._emit('error', error);
      return;
    }
    if (restart) this.start();
    this._emit('reset');
  }

  _circuitElements() {
    return this.elements.filter((el) => isCircuitElement(el));
  }

  _legacyElements() {
    return this.elements.filter((el) => !isCircuitElement(el) && !el._autorun
      && (el._sim || el._evaluateAsync || el._wasmBinary));
  }

  async _driveLegacy(legacy, prev) {
    if (!legacy.length) return;
    for (const link of this.connections) {
      if (isCircuitElement(link.toEl)) continue;
      link.toEl.inputs[link.toPin] = link.fromEl.outputs[link.fromPin] ?? 0;
    }
    for (const el of legacy) {
      el.inputs._prevInputs = prev.get(el) || {};
      await el.evaluate();
    }
  }

  _snapshot() {
    const snapshot = {};
    for (const el of this.elements) snapshot[el.name] = { ...el.outputs };
    return snapshot;
  }

  async rebuild() {
    if (!this._host || !this._circuitElements().length) return null;
    const sample = await this._host.sync(this);
    this._noteFault(sample);
    this._emit('step', { cycle: this.cycle, time: this.time, elements: this.elements });
    return sample;
  }

  _noteFault(sample) {
    if (!sample?.status || this._faulted) return;
    this._faulted = true;
    this._emit('fault', sample);
    this.stop();
  }

  /** Полпериода общего sc_clock. Дельта-циклы делает планировщик SystemC. */
  async step() {
    if (this._busy) return;
    this._busy = true;
    try {
      const legacy = this._legacyElements();
      const prev = new Map(legacy.map((el) => [el, { ...el.inputs }]));
      if (this._host && this._circuitElements().length) {
        const sample = await this._host.step(this);
        this._noteFault(sample);
      }
      await this._driveLegacy(legacy, prev);
      this.cycle++;
      const snapshot = this._snapshot();
      this.trace.push({ cycle: this.cycle, time: this.time, snapshot });
      if (this.trace.length > this.maxTrace) this.trace.shift();
      this._emit('step', { cycle: this.cycle, time: this.time, elements: this.elements });
      return snapshot;
    } catch (error) {
      this.stop();
      this._emit('error', error);
      throw error;
    } finally {
      this._busy = false;
    }
  }

  _startAutorun() {
    for (const el of this.elements) {
      if (el._runOnStart) Promise.resolve(el._runOnStart()).catch(() => {});
    }
  }

  start(intervalMs = 100) {
    if (this.running) return;
    this.running = true;
    this._emit('start');
    this._startAutorun();
    const stepFn = async () => {
      if (!this.running) return;
      try { await this.step(); } catch { /* error already emitted */ }
      if (!this.running) return;
      this._timer = setTimeout(stepFn, intervalMs);
    };
    this._timer = setTimeout(stepFn, intervalMs);
  }

  stop() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const el of this.elements) el._stopRun?.();
    this._emit('stop');
  }

  serializeConnections() {
    return this.connections.map(c => ({
      id: c.id,
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
    for (const [k, v] of Object.entries(config.initialOutputs || {})) this.outputs[k] = v;
    for (const [k, v] of Object.entries(config.initialState || {})) this.state[k] = v;

    this.cellType = config.cellType || 0;
    this.sourceFile = config.sourceFile || '';
    this.syscSource = config.source || '';
    if (config.evaluate) this._evaluateFn = config.evaluate;
    if (config.reset) this._resetFn = config.reset;
    if (config.isClock) this._isClock = true;
    if (config.sequential) this._sequential = true;
    if (bindCell) bindCell(this);
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
    const finish = () => {
      const changed = Object.keys(this.outputs).some(k => this.outputs[k] !== old[k]);
      if (changed) this._prevOutputs = old;
      return { changed };
    };
    if (this._evaluateAsync) {
      return Promise.resolve(this._evaluateAsync(this.inputs, this.outputs, this.state)).then(finish);
    }
    if (this._evaluateFn) this._evaluateFn(this.inputs, this.outputs, this.state);
    return finish();
  }

  reset() {
    for (const k of Object.keys(this.inputs)) this.inputs[k] = 0;
    for (const k of Object.keys(this.outputs)) this.outputs[k] = 0;
    this._prevInputs = {};
    if (this._resetAsync) return this._resetAsync();
    if (this._resetFn) this._resetFn(this.state);
  }

  dispose() {
    if (this._dispose) this._dispose();
  }
}

// ─── Фабрика готовых элементов ───────────────────────────────────────────────
// evaluate ниже — запасной путь, если cells.wasm не загрузился.
// При загрузке cells-runtime подменяет его на экземпляр SC_METHOD.
// cellType совпадает с enum в app/cells/harness.cpp.

let bindCell = null;
export function setCellBinder(fn) { bindCell = fn; }

const GATES = {};

function defineElement(type, config) {
  GATES[type] = config;
}

// ═══ Clock ══════════════════════════════════════════════════════════════════
// Единственный источник тактового сигнала. При каждом step() переключает clk.
defineElement('CLOCK', {
  label: 'Clock',
  cellType: 1,
  sourceFile: 'clock.cpp',
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
  label: 'VCC', cellType: 2, sourceFile: 'vcc.cpp',
  inputPins: [], outputPins: ['y'],
  color: '#FFD600', initialOutputs: { y: 1 },
  evaluate: (inp, out) => { out.y = 1; }
});
defineElement('GND', {
  label: 'GND', cellType: 3, sourceFile: 'gnd.cpp',
  inputPins: [], outputPins: ['y'],
  color: '#333', evaluate: (inp, out) => { out.y = 0; }
});

// ═══ Базовые вентили (combinatorial) ═══════════════════════════════════════

defineElement('AND', {
  label: 'AND', cellType: 4, sourceFile: 'and.cpp',
  inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#4CAF50', evaluate: (inp, out) => { out.y = inp.a & inp.b; }
});
defineElement('OR', {
  label: 'OR', cellType: 5, sourceFile: 'or.cpp',
  inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#FF9800', evaluate: (inp, out) => { out.y = inp.a | inp.b; }
});
defineElement('NOT', {
  label: 'NOT', cellType: 6, sourceFile: 'not.cpp',
  inputPins: ['a'], outputPins: ['y'],
  color: '#F44336', evaluate: (inp, out) => { out.y = inp.a ? 0 : 1; }
});
defineElement('NAND', {
  label: 'NAND', cellType: 7, sourceFile: 'nand.cpp',
  inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#607D8B', evaluate: (inp, out) => { out.y = (inp.a & inp.b) ? 0 : 1; }
});
defineElement('NOR', {
  label: 'NOR', cellType: 8, sourceFile: 'nor.cpp',
  inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#9C27B0', evaluate: (inp, out) => { out.y = (inp.a | inp.b) ? 0 : 1; }
});
defineElement('XOR', {
  label: 'XOR', cellType: 9, sourceFile: 'xor.cpp',
  inputPins: ['a', 'b'], outputPins: ['y'],
  color: '#00BCD4', evaluate: (inp, out) => { out.y = inp.a ^ inp.b; }
});

// ═══ D-триггер ══════════════════════════════════════════════════════════════
// clk — подключается к выходу Clock-элемента.
// Детекция rising edge через _rising('clk')
defineElement('DFF', {
  label: 'D-FF', cellType: 10, sourceFile: 'dff.cpp',
  inputPins: ['clk', 'd', 'rst_n'], outputPins: ['q', 'qn'],
  color: '#3F51B5', sequential: true,
  initialState: { qval: 0 },
  evaluate: (inp, out, state) => {
    // сброс по спадающему фронту rst_n (1→0), а не по статическому 0
    if (inp._prevInputs?.rst_n === 1 && inp.rst_n === 0) { state.qval = 0; }
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
  label: 'Ring Ctr', cellType: 11, sourceFile: 'ring4.cpp',
  inputPins: ['clk', 'rst_n', 'enable'], outputPins: ['q0', 'q1', 'q2', 'q3'],
  color: '#E91E63', sequential: true,
  initialState: { reg: 0b0001 },
  evaluate: (inp, out, state) => {
    // сброс по спадающему фронту rst_n (1→0)
    if (inp._prevInputs?.rst_n === 1 && inp.rst_n === 0) { state.reg = 0b0001; }
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
  label: 'Counter', cellType: 12, sourceFile: 'counter4.cpp',
  inputPins: ['clk', 'rst_n', 'enable'], outputPins: ['q0', 'q1', 'q2', 'q3'],
  color: '#009688', sequential: true,
  initialState: { val: 0 },
  evaluate: (inp, out, state) => {
    // сброс по спадающему фронту rst_n (1→0)
    if (inp._prevInputs?.rst_n === 1 && inp.rst_n === 0) { state.val = 0; }
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
  label: 'MUX 2→1', cellType: 13, sourceFile: 'mux2.cpp',
  inputPins: ['sel', 'a', 'b'], outputPins: ['y'],
  color: '#795548', evaluate: (inp, out) => { out.y = inp.sel ? inp.b : inp.a; }
});
defineElement('MUX4', {
  label: 'MUX 4→1', cellType: 14, sourceFile: 'mux4.cpp',
  inputPins: ['s0', 's1', 'a', 'b', 'c', 'd'], outputPins: ['y'],
  color: '#8D6E63', evaluate: (inp, out) => {
    const sel = (inp.s1 << 1) | inp.s0;
    out.y = [inp.a, inp.b, inp.c, inp.d][sel] ?? 0;
  }
});

// ═══ Полусумматор ═════════════════════════════════════════════════════════════
defineElement('HALF_ADDER', {
  label: 'Half Add', cellType: 15, sourceFile: 'half_adder.cpp',
  inputPins: ['a', 'b'], outputPins: ['sum', 'carry'],
  color: '#FF5722', evaluate: (inp, out) => {
    out.sum = inp.a ^ inp.b;
    out.carry = inp.a & inp.b;
  }
});

const BUILTIN_TYPES = new Set(Object.keys(GATES));

export function isBuiltinType(type) {
  return BUILTIN_TYPES.has(type);
}

// Экспорт
export { SimEngine, LogicElement, GATES, defineElement };
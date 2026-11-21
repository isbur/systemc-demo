/**
 * Canvas → one SystemC netlist.
 *
 * Each built-in cell type and each distinct user module is its own translation
 * unit. Each wire net is one channel (sc_signal<bool>, or sc_clock for a Clock).
 * Fan-out binds that channel to every input. top.cc includes no SystemC headers,
 * so a rewire recompiles only the top and relinks.
 */

export const CLOCK_PERIOD_NS = 10;

export const CELL_UNITS = {
  VCC: { className: 'Vcc', file: 'vcc.cpp', inputs: [], outputs: ['y'] },
  GND: { className: 'Gnd', file: 'gnd.cpp', inputs: [], outputs: ['y'] },
  AND: { className: 'And', file: 'and.cpp', inputs: ['a', 'b'], outputs: ['y'] },
  OR: { className: 'Or', file: 'or.cpp', inputs: ['a', 'b'], outputs: ['y'] },
  NOT: { className: 'Not', file: 'not.cpp', inputs: ['a'], outputs: ['y'] },
  NAND: { className: 'Nand', file: 'nand.cpp', inputs: ['a', 'b'], outputs: ['y'] },
  NOR: { className: 'Nor', file: 'nor.cpp', inputs: ['a', 'b'], outputs: ['y'] },
  XOR: { className: 'Xor', file: 'xor.cpp', inputs: ['a', 'b'], outputs: ['y'] },
  DFF: { className: 'Dff', file: 'dff.cpp', inputs: ['clk', 'd', 'rst_n'], outputs: ['q', 'qn'] },
  RING4: { className: 'Ring4', file: 'ring4.cpp', inputs: ['clk', 'rst_n', 'enable'], outputs: ['q0', 'q1', 'q2', 'q3'] },
  COUNTER4: { className: 'Counter4', file: 'counter4.cpp', inputs: ['clk', 'rst_n', 'enable'], outputs: ['q0', 'q1', 'q2', 'q3'] },
  MUX2: { className: 'Mux2', file: 'mux2.cpp', inputs: ['sel', 'a', 'b'], outputs: ['y'] },
  MUX4: { className: 'Mux4', file: 'mux4.cpp', inputs: ['s0', 's1', 'a', 'b', 'c', 'd'], outputs: ['y'] },
  HALF_ADDER: { className: 'HalfAdder', file: 'half_adder.cpp', inputs: ['a', 'b'], outputs: ['sum', 'carry'] },
};

const CANVAS_PORTS = ['clk', 'rst_n', 'enable', 'q'];

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function hasScMain(code) {
  return /\bsc_main\s*\(/.test(code);
}

function firstModule(code) {
  const ctor = /SC_CTOR\s*\(\s*(\w+)/.exec(code);
  const inherited = /(?:struct|class)\s+(\w+)\s*:[^{;]*\bsc_module\b/.exec(code);
  const macro = /SC_MODULE\s*\(\s*(\w+)\s*\)/.exec(code);
  const name = (ctor && ctor[1]) || (macro && macro[1]) || (inherited && inherited[1]);
  if (!name) return null;
  const anchor = code.search(new RegExp(
    `(?:struct|class)\\s+${name}\\b|SC_MODULE\\s*\\(\\s*${name}\\s*\\)`,
  ));
  const open = code.indexOf('{', anchor < 0 ? 0 : anchor);
  if (open < 0) return { name, body: '' };
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return { name, body: code.slice(open + 1, i) };
    }
  }
  return { name, body: '' };
}

function freeVoidFunctions(code) {
  const names = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    const match = /^void\s+(\w+)\s*\(\s*(?:void)?\s*\)/.exec(code.slice(i));
    if (!match || match[1] === 'sc_main') continue;
    names.push(match[1]);
    i += match[0].length - 1;
  }
  return names;
}

function modulePorts(body) {
  const ports = [];
  const re = /\bsc_(in|out|inout)\b/g;
  let match;
  while ((match = re.exec(body))) {
    let i = match.index + match[0].length;
    while (body[i] === ' ' || body[i] === '\n' || body[i] === '\t') i++;
    if (body[i] !== '<') continue;
    i++;
    let depth = 1;
    const start = i;
    while (i < body.length && depth > 0) {
      if (body[i] === '<') depth++;
      else if (body[i] === '>') depth--;
      i++;
    }
    const type = body.slice(start, i - 1).trim().replace(/\s+/g, ' ');
    const name = /^\s*(\w+)/.exec(body.slice(i));
    if (!name) continue;
    ports.push({ dir: match[1], type, name: name[1] });
    re.lastIndex = i + name[0].length;
  }
  return ports;
}

function isCanvasUint(ports) {
  if (ports.length !== CANVAS_PORTS.length) return false;
  const byName = new Map(ports.map((port) => [port.name, port]));
  if (!CANVAS_PORTS.every((name) => byName.has(name))) return false;
  const q = byName.get('q');
  if (q.dir === 'in') return false;
  return /sc_uint\s*<\s*4\s*>/.test(q.type);
}

function pinsOf(ports) {
  return {
    inputPins: ports.filter((port) => port.dir === 'in').map((port) => port.name),
    outputPins: ports.filter((port) => port.dir !== 'in').map((port) => port.name),
  };
}

export function moduleShape(code) {
  const empty = { kind: 'empty', className: '', factoryClass: '', ports: [], inputPins: [], outputPins: [] };
  if (!code || !String(code).trim()) return empty;
  if (hasScMain(code)) return { ...empty, kind: 'autorun', className: 'sc_main' };
  const plain = stripComments(code);
  const mod = firstModule(plain);
  const calls = freeVoidFunctions(plain);
  if (!mod) return { ...empty, kind: calls.length ? 'program' : 'empty' };
  const ports = modulePorts(mod.body);
  if (calls.length) {
    return { kind: 'program', className: mod.name, factoryClass: mod.name, ports, ...pinsOf(ports) };
  }
  if (isCanvasUint(ports)) {
    const q = ports.find((port) => port.name === 'q');
    return {
      kind: 'canvas-uint',
      className: mod.name,
      factoryClass: 'Canvas_' + mod.name,
      ports,
      qType: q.type,
      inputPins: ['clk', 'rst_n', 'enable'],
      outputPins: ['q0', 'q1', 'q2', 'q3'],
    };
  }
  if (ports.length && ports.every((port) => port.type.replace(/\s+/g, '') === 'bool')) {
    return { kind: 'bool', className: mod.name, factoryClass: mod.name, ports, ...pinsOf(ports) };
  }
  return { kind: 'other', className: mod.name, factoryClass: mod.name, ports, ...pinsOf(ports) };
}

export function isCircuitElement(el) {
  if (!el) return false;
  if (el.type === 'CLOCK' || Object.prototype.hasOwnProperty.call(CELL_UNITS, el.type)) return true;
  if (!el.syscSource) return false;
  const shape = moduleShape(el.syscSource);
  return shape.kind === 'bool' || shape.kind === 'canvas-uint';
}

function cmpUid(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function sanitize(value) {
  const text = String(value).replace(/[^A-Za-z0-9_]/g, '_');
  return text || 'x';
}

function linkLabel(conn) {
  if (conn.id != null && conn.id !== '') return String(conn.id);
  return `${conn.fromUid}_${conn.fromPin}_${conn.toUid}_${conn.toPin}`;
}

function factorySource(className, make, bind, ports) {
  const lines = ports.map((port) =>
    `  if (std::strcmp(port, "${port}") == 0) { m->${port}(*sig); return; }`);
  return `#include <cstring>

extern "C" {

void* ${make}(const char* name) {
  return new ${className}(name);
}

void ${bind}(void* raw, const char* port, void* sigp) {
  auto* m = static_cast<${className}*>(raw);
  auto* sig = static_cast<sc_core::sc_signal<bool>*>(sigp);
${lines.join('\n')}
}

}
`;
}

function canvasWrapper(shape) {
  return `
SC_MODULE(${shape.factoryClass}) {
  sc_in<bool> clk;
  sc_in<bool> rst_n;
  sc_in<bool> enable;
  sc_out<bool> q0;
  sc_out<bool> q1;
  sc_out<bool> q2;
  sc_out<bool> q3;
  sc_signal<${shape.qType}> bus;
  ${shape.className} dut;

  void split() {
    const auto value = bus.read();
    q0.write(value[0]);
    q1.write(value[1]);
    q2.write(value[2]);
    q3.write(value[3]);
  }

  SC_CTOR(${shape.factoryClass}) : dut("dut") {
    dut.clk(clk);
    dut.rst_n(rst_n);
    dut.enable(enable);
    dut.q(bus);
    SC_METHOD(split);
    sensitive << bus;
  }
};
`;
}

function ensureSystemCInclude(source) {
  if (/#\s*include\s*[<"]systemc(?:\.h)?[>"]/.test(source)) return source;
  return '#include "systemc.h"\n' + source;
}

function cellUnit(cell) {
  const make = 'mk_' + cell.className;
  const bind = 'bind_' + cell.className;
  const ports = [...cell.inputs, ...cell.outputs];
  return {
    id: 'cell_' + cell.className,
    filename: 'cell_' + cell.className + '.cc',
    role: 'module',
    symbol: make,
    bind,
    includes: [cell.file],
    source: `#include "${cell.file}"\n` + factorySource(cell.className, make, bind, ports),
  };
}

function userUnit(source, shape, symbol) {
  const make = symbol;
  const bind = symbol.replace(/^mk_/, 'bind_');
  const ports = shape.kind === 'canvas-uint'
    ? ['clk', 'rst_n', 'enable', 'q0', 'q1', 'q2', 'q3']
    : [...shape.inputPins, ...shape.outputPins];
  const body = shape.kind === 'canvas-uint' ? canvasWrapper(shape) : '';
  return {
    id: 'mod_' + symbol,
    filename: symbol + '.cc',
    role: 'module',
    symbol: make,
    bind,
    includes: [],
    source: ensureSystemCInclude(source).replace(/\s*$/, '\n') + body + factorySource(shape.factoryClass, make, bind, ports),
  };
}

function renderTop(symbols, body) {
  const decls = [
    'void rt_configure(int period_ns);',
    'int rt_add_bool(const char* name);',
    'int rt_add_clock(const char* name);',
    'void* rt_ptr(int id);',
  ];
  for (const symbol of symbols) {
    decls.push(`void* ${symbol.make}(const char* name);`);
    decls.push(`void ${symbol.bind}(void* raw, const char* port, void* sig);`);
  }
  const lines = body.length ? body.map((line) => (line ? '  ' + line : '')).join('\n') : '';
  return `/* Generated canvas netlist. Do not edit.
 * One sc_signal or sc_clock per wire net. Fan-out binds that channel to every input.
 * This file includes no SystemC headers, so a rewire recompiles only the top and relinks.
 */
extern "C" {

${decls.join('\n')}

void circuit_build(void) {
  rt_configure(${CLOCK_PERIOD_NS});
${lines}
}

}
`;
}

function portsOfElement(el) {
  if (el.type === 'CLOCK') return { inputs: [], outputs: ['clk'] };
  if (CELL_UNITS[el.type]) {
    return { inputs: CELL_UNITS[el.type].inputs, outputs: CELL_UNITS[el.type].outputs };
  }
  const shape = el.shape || moduleShape(el.source || '');
  return { inputs: shape.inputPins, outputs: shape.outputPins };
}

function emptyManifest() {
  return { channels: [], byPin: {}, uids: [], periodNs: CLOCK_PERIOD_NS, stepNs: CLOCK_PERIOD_NS / 2 };
}

export function generateCircuit(model) {
  const elements = [...(model.elements || [])];
  const connections = [...(model.connections || [])];
  const byUid = new Map(elements.map((el) => [String(el.uid), el]));
  const fail = (error) => ({ error, top: '', units: [], manifest: emptyManifest() });

  for (const el of elements) {
    if (el.type === 'CLOCK' || CELL_UNITS[el.type]) continue;
    const shape = moduleShape(el.source || '');
    if (shape.kind !== 'bool' && shape.kind !== 'canvas-uint') {
      return fail(`блок ${el.uid} (${el.type}) не входит в общее ядро: ${shape.kind}`);
    }
    el.shape = shape;
  }

  const groups = new Map();
  const inputDriver = new Map();
  for (const conn of connections) {
    const from = byUid.get(String(conn.fromUid));
    const to = byUid.get(String(conn.toUid));
    if (!from || !to) return fail(`связь ${linkLabel(conn)} указывает на отсутствующий блок`);
    const fromPorts = portsOfElement(from);
    const toPorts = portsOfElement(to);
    if (!fromPorts.outputs.includes(conn.fromPin)) return fail(`выход ${from.uid}.${conn.fromPin} не существует`);
    if (!toPorts.inputs.includes(conn.toPin)) return fail(`вход ${to.uid}.${conn.toPin} не существует`);
    const driver = String(conn.fromUid) + '\0' + conn.fromPin;
    const input = String(conn.toUid) + '\0' + conn.toPin;
    if (inputDriver.has(input) && inputDriver.get(input) !== driver) {
      return fail(`вход ${to.uid}.${conn.toPin} подключён к двум выходам`);
    }
    inputDriver.set(input, driver);
    if (!groups.has(driver)) groups.set(driver, []);
    groups.get(driver).push(conn);
  }

  const channels = [];
  const byPin = {};
  const touch = (uid, pin, id) => {
    (byPin[String(uid)] ??= {})[pin] = id;
  };

  const nets = [];
  for (const el of elements) {
    const ports = portsOfElement(el);
    for (const pin of ports.outputs) {
      const driver = String(el.uid) + '\0' + pin;
      const conns = groups.get(driver) || [];
      const linked = conns.length > 0;
      const name = linked
        ? 'sig_' + sanitize(conns.map(linkLabel).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0])
        : (el.type === 'CLOCK' ? 'clk_' + sanitize(el.uid) : 'pin_' + sanitize(el.uid) + '_' + pin);
      nets.push({
        name,
        kind: el.type === 'CLOCK' ? 'clock' : 'bool',
        driver: { uid: String(el.uid), pin },
        targets: conns.map((conn) => ({ uid: String(conn.toUid), pin: conn.toPin })),
      });
    }
  }
  nets.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'clock' ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });

  const names = new Set();
  for (const net of nets) {
    if (names.has(net.name)) return fail(`имя канала ${net.name} повторяется`);
    names.add(net.name);
    const id = channels.length;
    channels.push({ id, name: net.name, kind: net.kind });
    touch(net.driver.uid, net.driver.pin, id);
    for (const target of net.targets) touch(target.uid, target.pin, id);
  }

  const opens = [];
  for (const el of elements) {
    const ports = portsOfElement(el);
    for (const pin of ports.inputs) {
      if (byPin[String(el.uid)]?.[pin] != null) continue;
      opens.push({ uid: String(el.uid), pin, name: 'open_' + sanitize(el.uid) + '_' + pin });
    }
  }
  opens.sort((a, b) => cmpUid(a.uid, b.uid) || a.pin.localeCompare(b.pin));
  for (const open of opens) {
    if (names.has(open.name)) return fail(`имя канала ${open.name} повторяется`);
    names.add(open.name);
    const id = channels.length;
    channels.push({ id, name: open.name, kind: 'bool' });
    touch(open.uid, open.pin, id);
  }

  const units = [];
  const unitByType = new Map();
  const unitBySource = new Map();
  const usedSymbols = new Set();
  const binding = new Map();

  for (const el of elements.filter((item) => item.type !== 'CLOCK').sort((a, b) => cmpUid(a.uid, b.uid))) {
    if (CELL_UNITS[el.type]) {
      let unit = unitByType.get(el.type);
      if (!unit) {
        unit = cellUnit(CELL_UNITS[el.type]);
        unitByType.set(el.type, unit);
        units.push(unit);
        usedSymbols.add(unit.symbol);
      }
      binding.set(el, unit);
      continue;
    }
    const shape = el.shape || moduleShape(el.source || '');
    const key = shape.kind + '\0' + (el.source || '');
    let unit = unitBySource.get(key);
    if (!unit) {
      let symbol = 'mk_usr_' + sanitize(shape.factoryClass);
      if (usedSymbols.has(symbol)) symbol += '_' + sanitize(el.uid);
      usedSymbols.add(symbol);
      unit = userUnit(el.source || '', shape, symbol);
      unitBySource.set(key, unit);
      units.push(unit);
    }
    binding.set(el, unit);
  }

  const body = [];
  for (const channel of channels) {
    const fn = channel.kind === 'clock' ? 'rt_add_clock' : 'rt_add_bool';
    body.push(`int ${channel.name} = ${fn}("${channel.name}");`);
  }
  const instances = [...binding.keys()].sort((a, b) => cmpUid(a.uid, b.uid));
  if (instances.length && body.length) body.push('');
  for (const el of instances) {
    const unit = binding.get(el);
    const ports = portsOfElement(el);
    const varName = 'e_' + sanitize(el.uid);
    const inst = sanitize(unit.symbol.replace(/^mk_usr_/, '').replace(/^mk_/, '')).toLowerCase() + '_' + sanitize(el.uid);
    body.push(`void* ${varName} = ${unit.symbol}("${inst}");`);
    for (const pin of [...ports.inputs, ...ports.outputs]) {
      const channel = channels[byPin[String(el.uid)][pin]];
      body.push(`${unit.bind}(${varName}, "${pin}", rt_ptr(${channel.name}));`);
    }
  }

  const symbols = [...new Map(units.map((unit) => [unit.symbol, unit])).values()]
    .map((unit) => ({ make: unit.symbol, bind: unit.bind }))
    .sort((a, b) => a.make.localeCompare(b.make));
  const top = renderTop(symbols, body);
  units.push({
    id: 'top',
    filename: 'top.cc',
    role: 'top',
    symbol: '',
    bind: '',
    includes: [],
    source: top,
  });

  return {
    error: null,
    top,
    units,
    manifest: {
      channels,
      byPin,
      uids: elements.map((el) => String(el.uid)),
      periodNs: CLOCK_PERIOD_NS,
      stepNs: CLOCK_PERIOD_NS / 2,
    },
  };
}

export function modelFromEngine(engine) {
  const elements = [];
  for (const el of engine.elements || []) {
    if (!isCircuitElement(el)) continue;
    elements.push({
      uid: String(el.uid),
      type: el.type,
      source: el.syscSource || '',
    });
  }
  const live = new Set(elements.map((el) => el.uid));
  const connections = [];
  for (const conn of engine.connections || []) {
    const fromUid = String(conn.fromEl?.uid ?? conn.fromUid);
    const toUid = String(conn.toEl?.uid ?? conn.toUid);
    if (!live.has(fromUid) || !live.has(toUid)) continue;
    connections.push({
      id: conn.id,
      fromUid,
      fromPin: conn.fromPin,
      toUid,
      toPin: conn.toPin,
    });
  }
  return { elements, connections };
}

export function circuitFingerprint(model) {
  const elements = [...model.elements].map((el) => ({
    uid: String(el.uid),
    type: el.type,
    source: el.type === 'CLOCK' || CELL_UNITS[el.type] ? '' : (el.source || ''),
  })).sort((a, b) => cmpUid(a.uid, b.uid));
  const connections = [...model.connections].map((conn) => ({
    id: conn.id ?? null,
    fromUid: String(conn.fromUid),
    fromPin: conn.fromPin,
    toUid: String(conn.toUid),
    toPin: conn.toPin,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
    || a.fromUid.localeCompare(b.fromUid)
    || a.fromPin.localeCompare(b.fromPin)
    || a.toUid.localeCompare(b.toUid)
    || a.toPin.localeCompare(b.toPin));
  return JSON.stringify({ elements, connections });
}

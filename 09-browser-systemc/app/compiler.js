/**
 * Компиляция C++ / SystemC → WASM в браузере через @yowasp/clang.
 *
 * compileCpp(code, deps) — главный экспорт.
 * deps: { viz, GATES, log, setStatus }
 */

import { makeWasiPreview1 } from './wasi.js';
import { editorClangArgs } from './pthread-link.js';
import { createSimSession } from './sim-host.js';
import { moduleShape } from './netlist.js';

function asset(path) {
  return new URL(path, import.meta.url).href;
}

const SYSTEMC_CORE_O = asset('../pthread-host/systemc-core-pthread.o');
const SC_IDS_O = asset('../pthread-host/sc_ids-pthread.o');
const SYSTEMC_VFS_JSON = asset('./systemc-vfs.json');
const WASI_INCLUDE_JSON = asset('../../wasi-include.json');
const LIB_ROOT = asset('../pthread-host/wasi');
const CLANG_CDN = 'https://cdn.jsdelivr.net/npm/@yowasp/clang/+esm';

// Предзагрузка @yowasp/clang сразу при загрузке страницы (105 MB качается заранее)
const clangPromise = import(CLANG_CDN).then(m => m, () => {});

/**
 * Проверить, использует ли код SystemC.
 */
function usesSystemC(code) {
  return /#\s*include\s*[<"]systemc(?:\.h)?[>"]/.test(code)
    || /\b(?:SC_MODULE|SC_CTOR|SC_METHOD|SC_THREAD|SC_CTHREAD|SC_HAS_PROCESS|sc_main|sc_start|sc_signal|sc_module|sc_core)\b/.test(code);
}

const CANVAS_PORTS = ['clk', 'rst_n', 'enable', 'q'];

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function ctorName(code) {
  const match = /SC_CTOR\s*\(\s*(\w+)/.exec(code);
  return match ? match[1] : null;
}

function firstModule(code) {
  const ctor = ctorName(code);
  const inherited = /(?:struct|class)\s+(\w+)\s*:[^{;]*\bsc_module\b/.exec(code);
  const macro = /SC_MODULE\s*\(\s*(\w+)\s*\)/.exec(code);
  const name = ctor || (macro && macro[1]) || (inherited && inherited[1]);
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

/** Обычные void() на верхнем уровне. Методы внутри struct/class не берём. */
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
  const re = /\bsc_(?:in|out|inout)\b/g;
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
    const type = body.slice(start, i - 1).trim();
    const name = /^\s*(\w+)/.exec(body.slice(i));
    if (!name) continue;
    ports.push({ type, name: name[1] });
    re.lastIndex = i + name[0].length;
  }
  return ports;
}

function isCanvasModule(ports) {
  const names = new Set(ports.map((port) => port.name));
  return CANVAS_PORTS.every((name) => names.has(name));
}

function hasUserScMain(code) {
  return /\bsc_main\s*\(/.test(code);
}

/**
 * Программа со своим sc_main. Канва её не оборачивает в кольцевой регистр:
 * init() просто вызывает этот sc_main, печать уходит в консоль.
 */
function wrapStandalone(code) {
  return code + `
extern "C" {
int init() {
  static char arg0[] = "module";
  static char* argv[] = { arg0, nullptr };
  return sc_main(1, argv);
}
void reset_ring() {}
int step() { return 0; }
int get_q() { return 0; }
void set_enable(int) {}
}
`;
}

/**
 * Сгенерировать обёртку для SC_MODULE без своего sc_main:
 * сигналы clk/rst_n/enable/q и экспорты, которыми шагает канва.
 */
function wrapSystemC(code, modName) {
  return code + `
int sc_main(int, char*[]) { return 0; }
static sc_signal<bool>* clk_p; static sc_signal<bool>* rst_p; static sc_signal<bool>* en_p;
static sc_signal<sc_dt::sc_uint<4>>* q_p; static ${modName}* dut;
extern "C" {
void init() { if(dut)return;
  clk_p=new sc_signal<bool>("clk"); rst_p=new sc_signal<bool>("rst"); en_p=new sc_signal<bool>("en");
  q_p=new sc_signal<sc_dt::sc_uint<4>>("q"); dut=new ${modName}("dut");
  dut->clk(*clk_p); dut->rst_n(*rst_p); dut->enable(*en_p); dut->q(*q_p);
  *clk_p=false; *rst_p=false; *en_p=false;
}
void reset_ring() { *rst_p=false; sc_start(SC_ZERO_TIME); *rst_p=true; sc_start(SC_ZERO_TIME); }
int32_t step() { *en_p=true; *clk_p=true; sc_start(SC_ZERO_TIME); int32_t v=q_p->read().to_int(); *clk_p=false; sc_start(SC_ZERO_TIME); return v; }
int32_t get_q() { return q_p->read().to_int(); }
void set_enable(int32_t e) { *en_p = (e!=0); }
}`;
}

/**
 * Модуль без своего sc_main и без портов канвы.
 * Редактор сам создаёт объект, связывает найденные порты и крутит 10 секунд.
 */
function wrapRunner(code, name, ports, calls, timed) {
  const signals = ports.map((port, index) =>
    `static sc_signal<${port.type}> sig_${index}("${port.name}");`).join('\n');
  const binds = ports.map((port, index) => `  dut.${port.name}(sig_${index});`).join('\n');
  const prologue = calls.map((fn) => `  ${fn}();`).join('\n');
  const start = timed ? 'sc_start(10, SC_SEC);' : 'sc_start(SC_ZERO_TIME);';
  const module = name ? `  ${name} dut("dut");\n${binds}\n` : '';
  return code + `
${signals}
int sc_main(int, char*[]) {
${prologue}
${module}  ${start}
  return 0;
}
extern "C" {
int init() {
  static char arg0[] = "module";
  static char* argv[] = { arg0, nullptr };
  return sc_main(1, argv);
}
void reset_ring() {}
int step() { return 0; }
int get_q() { return 0; }
void set_enable(int) {}
}
`;
}

export function prepareSystemCSource(code) {
  if (hasUserScMain(code)) {
    return { code: wrapStandalone(code), mode: 'autorun', note: '▶ sc_main', title: 'sc_main' };
  }
  const plain = stripComments(code);
  const mod = firstModule(plain);
  const calls = freeVoidFunctions(plain);
  if (!mod && calls.length === 0) return { code, mode: 'gate', note: '', title: '' };
  const ports = mod ? modulePorts(mod.body) : [];
  if (mod && isCanvasModule(ports) && calls.length === 0) {
    return { code: wrapSystemC(code, mod.name), mode: 'gate', note: '', title: mod.name };
  }
  const who = [...calls, mod?.name].filter(Boolean).join(', ');
  const timed = /\bSC_THREAD\b|\bwait\s*\(/.test(plain);
  const start = timed ? 'sc_start(10, SC_SEC)' : 'sc_start(SC_ZERO_TIME)';
  const title = mod?.name || calls[0] || 'SysC';
  const mode = ports.length === 0 ? 'autorun' : 'immediate';
  return {
    code: wrapRunner(code, mod?.name, ports, calls, timed),
    mode,
    note: `▶ ${who}, ${start}`,
    title,
  };
}

/**
 * Добавить скомпилированный WASM-модуль на визуальную канву.
 * Пины: rst_n, enable (входы); q0..q3 (выходы).
 */
function writeQ(out, value) {
  const v = value | 0;
  out.q0 = (v >> 0) & 1;
  out.q1 = (v >> 1) & 1;
  out.q2 = (v >> 2) & 1;
  out.q3 = (v >> 3) & 1;
}

export function attachWasmElement(el, session) {
  el._sim = session;
  el._sequential = true;
  el._evaluateAsync = async (inp, out) => {
    const fallingRst = inp._prevInputs?.rst_n === 1 && inp.rst_n === 0;
    const risingClk = inp._prevInputs?.clk === 0 && inp.clk === 1;
    let value = 0;
    if (fallingRst) {
      await session.call('reset_ring');
    } else if (risingClk) {
      await session.call('set_enable', [inp.enable ? 1 : 0]);
      value = await session.call('step');
      writeQ(out, value);
      return;
    }
    value = await session.call('get_q');
    writeQ(out, value);
  };
  el._resetAsync = () => session.call('reset_ring');
}

function placeOnCanvas(label, viz, GATES, addPaletteItem, options = {}) {
  const typeId = 'wasm-module-' + Date.now();
  const pmm = {
    label,
    inputPins: options.inputPins ?? ['clk', 'rst_n', 'enable'],
    outputPins: options.outputPins ?? ['q0', 'q1', 'q2', 'q3'],
    color: '#673AB7',
  };
  if (options.autorun) pmm.autorun = true;
  GATES[typeId] = pmm;
  if (addPaletteItem && !options.autorun) addPaletteItem(typeId, pmm);
  viz.addElement(typeId, 300, 200);
  const view = Array.from(viz.elementViews.values()).pop();
  if (view && options.autorun) {
    view.width = Math.max(90, label.length * 8 + 28);
    viz._renderElement(view);
  }
  return view;
}

function addPlainToCanvas(exports, label, viz, GATES, addPaletteItem, wasmBuf) {
  const lv = placeOnCanvas(label, viz, GATES, addPaletteItem);
  if (!lv) return;
  lv.el.name = label;
  lv.el._wasmBinary = wasmBuf;
  lv.el._sequential = true;
  lv.el._evaluateFn = (inp, out) => {
    const fallingRst = inp._prevInputs?.rst_n === 1 && inp.rst_n === 0;
    const risingClk = inp._prevInputs?.clk === 0 && inp.clk === 1;
    if (fallingRst) {
      if (exports.reset_ring) exports.reset_ring();
    } else if (risingClk) {
      if (exports.set_enable) exports.set_enable(inp.enable ?? 0);
      writeQ(out, exports.step ? exports.step() : 0);
      return;
    }
    writeQ(out, exports.get_q ? exports.get_q() : 0);
  };
  lv.el._resetFn = () => { if (exports.reset_ring) exports.reset_ring(); };
  viz._renderElement(lv);
}

function addWasmToCanvas(session, label, viz, GATES, addPaletteItem, wasmBuf) {
  const lv = placeOnCanvas(label, viz, GATES, addPaletteItem);
  if (!lv) return;
  lv.el.name = label;
  lv.el._wasmBinary = wasmBuf;
  attachWasmElement(lv.el, session);
  viz._renderElement(lv);
}

/**
 * Блок без пинов. init() вызывается при старте симуляции, не при компиляции.
 * Повторный старт поднимает новый экземпляр: ядро SystemC нельзя прогнать дважды.
 */
export async function mountAutorunElement(el, wasmBuf, logWasm, logError, sessions) {
  el._wasmBinary = wasmBuf;
  el._autorun = true;
  let generation = 0;
  let current = null;
  let primed = null;

  async function open() {
    const session = createSimSession(logWasm, logError);
    sessions?.push(session);
    current = session;
    await session.load(wasmBuf);
    return session;
  }

  primed = open();

  el._runOnStart = async () => {
    const my = ++generation;
    let session = null;
    try {
      session = await primed;
    } catch {
      session = null;
    }
    if (my !== generation) return;
    if (!session || session !== current) {
      primed = open();
      try {
        session = await primed;
      } catch (error) {
        if (my !== generation) return;
        logError(error.message || String(error));
        return;
      }
    }
    if (my !== generation) return;
    primed = Promise.resolve(null);
    try {
      const status = await session.call('init');
      if (my !== generation) return;
      logWasm('sc_main вернул ' + status);
    } catch (error) {
      if (my !== generation) return;
      logError(error.message || String(error));
    }
    if (current === session) current = null;
    session.dispose();
  };

  el._stopRun = () => {
    generation++;
    const dying = current;
    current = null;
    primed = Promise.resolve(null);
    dying?.dispose();
  };
  el._dispose = () => el._stopRun();
  el._resetAsync = () => el._stopRun();
  await primed;
}

/**
 * Инстанциировать WASM с WASI polyfill и вызвать конструкторы.
 */
async function instantiateWasm(wasmBuf, log) {
  const wasi = makeWasiPreview1((msg) => log(msg, 'line'));
  const inst = await WebAssembly.instantiate(
    await WebAssembly.compile(wasmBuf),
    { wasi_snapshot_preview1: wasi },
  );
  wasi._setMemory(inst.exports.memory);
  const ex = inst.exports;
  if (ex.__wasm_call_ctors) {
    ex.__wasm_call_ctors();
  }
  return ex;
}

// ═══ Предзагрузка WASM-чанков LLVM в Cache API ═══════════════════

const CACHE_NAME = 'llvm-chunks-v1';
const LLVM_CHUNKS = [
  'llvm.core.wasm', 'llvm.core2.wasm',
  'llvm.core3.wasm', 'llvm.core4.wasm',
];
const LLVM_BASE = 'https://cdn.jsdelivr.net/npm/@yowasp/clang/gen/';

/** Предзагрузить WASM-чанки последовательно (чтоб прогресс был точным),
 *  затем сохранить в Cache API. При повторных вызовах берёт из кэша. */
async function prefetchLLVM(setProgress) {
  const cache = await caches.open(CACHE_NAME);
  const uncached = [];

  for (const chunk of LLVM_CHUNKS) {
    const url = LLVM_BASE + chunk;
    const cached = await cache.match(url);
    if (!cached) uncached.push(chunk);
  }

  if (uncached.length === 0) {
    if (setProgress) setProgress(100, 100, '✅ LLVM (из кэша)');
    return;
  }

  // Узнаём общий размер
  let total = 0;
  const sizes = {};
  for (const c of uncached) {
    try {
      const r = await fetch(LLVM_BASE + c, { method: 'HEAD' });
      sizes[c] = parseInt(r.headers.get('content-length') || '0', 10) || 25_000_000;
    } catch { sizes[c] = 25_000_000; }
    total += sizes[c];
  }

  // Скачиваем последовательно — прогресс настоящий
  let loaded = 0;
  for (const c of uncached) {
    const r = await fetch(LLVM_BASE + c);
    // Сразу кэшируем Response (его можно использовать только один раз)
    const clone = r.clone();
    cache.put(LLVM_BASE + c, clone);
    // Читаем для прогресса
    const rd = r.body.getReader();
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      loaded += value.length;
      const pct = Math.round(loaded / total * 100);
      if (setProgress) setProgress(pct, 100, `⬇ LLVM ${pct}%`);
    }
  }
  if (setProgress) setProgress(100, 100, '✅ LLVM загружен');
}

/**
 * Компиляция кода пользователя с линковкой к предсобранному systemc-unity.o.
 * Загружаем @yowasp/clang, unity.o, VFS-заголовки, компилируем main.cc, линкуем.
 */
const LIB_FILES = {
  'libc++.a': LIB_ROOT + '/eh/libc++.a',
  'libc++abi.a': LIB_ROOT + '/eh/libc++abi.a',
  'libunwind.a': LIB_ROOT + '/eh/libunwind.a',
  'libc.a': LIB_ROOT + '/libc.a',
  'libpthread.a': LIB_ROOT + '/libpthread.a',
  'crt1.o': LIB_ROOT + '/crt1.o',
  'libclang_rt.builtins.a': asset('../pthread-host/wasi/libclang_rt.builtins.a'),
};

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ' → ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

let toolchainPromise;
function loadToolchain() {
  toolchainPromise ??= (async () => {
    const entries = await Promise.all(Object.entries(LIB_FILES).map(async ([name, url]) => [name, await fetchBytes(url)]));
    const libs = Object.fromEntries(entries);
    const include = await (await fetch(WASI_INCLUDE_JSON)).json();
    return { libs, include };
  })();
  return toolchainPromise;
}

async function compileSystemC(code, deps) {
  const { log, setStatus, setProgress = () => {} } = deps;

  setStatus('⏳ Загрузка компилятора...');
  log('⏳ Предзагрузка LLVM (105 MB)...', 'info');
  await prefetchLLVM(setProgress);
  log('✅ LLVM загружен', 'info');
  setStatus('⏳ Загрузка артефактов...');

  // Фаза 2: загружаем clang module + SystemC артефакты (70-85%)
  setProgress(70, 100, '⏳ Загрузка артефактов...');

  const [clangMod, coreBuf, idsBuf, headersVFS, toolchain] = await Promise.all([
    clangPromise,
    fetchBytes(SYSTEMC_CORE_O),
    fetchBytes(SC_IDS_O),
    fetch(SYSTEMC_VFS_JSON).then((response) => response.json()),
    loadToolchain(),
  ]);
  const { runClang } = clangMod;
  const { libs, include } = toolchain;

  const prepared = prepareSystemCSource(code);
  const wrapCode = prepared.code;

  setProgress(85, 100, '⚙ Компиляция...');
  log('⚙ Компиляция кода пользователя + линковка с SystemC...', 'info');
  setStatus('⏳ Компиляция...');

  const vfs = {
    'main.cc': wrapCode,
    'systemc-core.o': coreBuf,
    'sc_ids.o': idsBuf,
    ...headersVFS,
    sysroot: {
      include,
      lib: {
        'wasm32-wasip1-threads': {
          'libc.a': libs['libc.a'],
          'libpthread.a': libs['libpthread.a'],
          'crt1.o': libs['crt1.o'],
          eh: {
            'libc++.a': libs['libc++.a'],
            'libc++abi.a': libs['libc++abi.a'],
            'libunwind.a': libs['libunwind.a'],
          },
        },
        'wasm32-unknown-wasip1-threads': {
          'libclang_rt.builtins.a': libs['libclang_rt.builtins.a'],
        },
      },
    },
  };

  let clangLog = '';
  let result;
  try {
    result = await runClang(editorClangArgs(), vfs, {
      stderr: (bytes) => { if (bytes) clangLog += new TextDecoder().decode(bytes); },
    });
  } catch (error) {
    const errors = clangLog.split('\n').filter((line) => line.includes('error:')).slice(0, 30);
    throw new Error(errors.join('\n') || clangLog.slice(-2000) || error.message);
  }
  const wasmBuf = result['module.wasm'];
  if (!wasmBuf) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
    throw new Error(stderr || 'no wasm output');
  }

  return { wasmBuf, mode: prepared.mode, note: prepared.note, title: prepared.title };
}

/**
 * Компиляция plain C++ кода (без SystemC).
 */
async function compilePlainCpp(code, deps) {
  const { log, setStatus, setProgress } = deps;
  const safeProgress = setProgress || (() => {});

  safeProgress(0, 100, '⏳ Загрузка LLVM...');
  log('⏳ Предзагрузка LLVM (105 MB)...', 'info');
  setStatus('⏳ LLVM...');
  await prefetchLLVM(setProgress);

  const clangMod = await clangPromise;
  const { runClang } = clangMod;

  safeProgress(85, 100, '⚙ Компиляция...');
  log('⚙ Компиляция C++ → WASM...', 'info');
  setStatus('⏳ Компиляция...');

  let clangLog = '';
  let result;
  try {
    result = await runClang([
      'clang++', '-std=c++17', 'module.cc', '-o', 'module.wasm',
      '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable',
      '--target=wasm32-wasi', '-O2',
    ], { 'module.cc': code }, {
      stderr: (bytes) => { if (bytes) clangLog += new TextDecoder().decode(bytes); },
    });
  } catch (error) {
    const errors = clangLog.split('\n').filter((line) => /error:|fatal error:/.test(line)).slice(0, 30);
    throw new Error(errors.join('\n') || clangLog.slice(-2000) || error.message);
  }

  const wasmBuf = result['module.wasm'];
  if (!wasmBuf) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
    throw new Error(stderr || 'no wasm output');
  }
  return wasmBuf;
}

async function placeStructuralModule(code, shape, deps) {
  const { viz, GATES, log, setStatus, addPaletteItem, sim } = deps;
  const typeId = 'wasm-module-' + Date.now();
  const config = {
    label: shape.className,
    inputPins: [...shape.inputPins],
    outputPins: [...shape.outputPins],
    color: '#673AB7',
    source: code,
  };
  GATES[typeId] = config;
  if (addPaletteItem) addPaletteItem(typeId, config);
  const el = viz.addElement(typeId, 300, 200);
  if (el) {
    el.syscSource = code;
    el.name = shape.className;
  }
  log(`Модуль ${shape.className} добавлен в общее ядро`, 'ok');
  setStatus('Сборка схемы…');
  if (sim?.rebuild) await sim.rebuild();
}

/**
 * Главная функция компиляции.
 *
 * @param {string} code — исходный код C++/SystemC из редактора
 * @param {object} deps — зависимости:
 *   viz       — VisualConstructor (для добавления wasm-элемента)
 *   GATES     — таблица элементов
 *   log       — функция логирования (msg, cssClass)
 *   setStatus — функция обновления статус-текста (text)
 */
export async function compileCpp(code, deps) {
  const { log, setStatus, setProgress = () => {} } = deps;

  const hasSysC = usesSystemC(code);

  try {
    if (hasSysC) {
      const shape = moduleShape(code);
      if (shape.kind === 'bool' || shape.kind === 'canvas-uint') {
        await placeStructuralModule(code, shape, deps);
        setProgress(100, 100, '✅ В общем ядре');
        setStatus(`✅ ${shape.className}`);
        return;
      }
    }
    const built = hasSysC
      ? await compileSystemC(code, deps)
      : { wasmBuf: await compilePlainCpp(code, deps), mode: 'gate', note: '', title: '' };
    const { wasmBuf, mode, note, title } = built;

    setProgress(95, 100, '⏳ Инстанциирование...');
    log('✅ Компиляция успешна, инстанциирование...', 'info');
    setStatus('⏳ Инстанциирование...');

    const label = hasSysC ? 'SysC' : 'Wasm';
    if (hasSysC && mode === 'autorun') {
      log(note || '▶ модуль', 'info');
      const view = placeOnCanvas(title || 'SysC', deps.viz, deps.GATES, deps.addPaletteItem, {
        autorun: true,
        inputPins: [],
        outputPins: [],
      });
      try {
        await mountAutorunElement(
          view.el,
          wasmBuf,
          (text) => log(text, text.startsWith('sc_main') ? 'ok' : 'wasm'),
          (text) => log(text, 'err'),
          deps.sessions,
        );
      } catch (error) {
        if (view) deps.viz.deleteElement(view.uid);
        throw error;
      }
      log('Блок без выводов на схеме, старт по ▶', 'ok');
    } else if (hasSysC) {
      const session = createSimSession(
        (text) => (deps.logWasm || log)(text, 'wasm'),
        (text) => log(text, 'err'),
      );
      deps.sessions?.push(session);
      await session.load(wasmBuf);
      if (mode === 'immediate') {
        log(note || '▶ sc_main', 'info');
        const status = await session.call('init');
        log('sc_main вернул ' + status, 'ok');
      } else {
        await session.call('init');
        await session.call('reset_ring');
        addWasmToCanvas(session, label, deps.viz, deps.GATES, deps.addPaletteItem, wasmBuf);
      }
    } else {
      const exports = await instantiateWasm(wasmBuf, log);
      if (exports.init && exports.reset_ring) {
        exports.init();
        exports.reset_ring();
      }
      addPlainToCanvas(exports, label, deps.viz, deps.GATES, deps.addPaletteItem, wasmBuf);
    }
    setProgress(100, 100, '✅ Готово');
    setStatus(`✅ ${label} in-browser`);

  } catch (err) {
    log('❌ ' + (err.message || err), 'err');
    setStatus('❌ Ошибка');
    }
}

export async function restoreWasmSession(binaryOrBase64, logWasm, logError) {
  const binary = typeof binaryOrBase64 === 'string'
    ? Uint8Array.from(atob(binaryOrBase64), (c) => c.charCodeAt(0))
    : binaryOrBase64;
  const session = createSimSession(logWasm, logError);
  await session.load(binary);
  await session.call('init');
  await session.call('reset_ring');
  return session;
}
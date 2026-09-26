/**
 * Компиляция C++ / SystemC → WASM в браузере через @yowasp/clang.
 *
 * compileCpp(code, deps) — главный экспорт.
 * deps: { viz, GATES, log, setStatus }
 */

import { makeWasiPreview1 } from './wasi.js';

// URL для статических артефактов SystemC
const SYSTEMC_CORE_O = '/app/systemc-core.o';
const SC_IDS_O = '/app/sc_ids.o';
const SYSTEMC_VFS_JSON = '/app/systemc-vfs.json';
const CLANG_CDN = 'https://cdn.jsdelivr.net/npm/@yowasp/clang/+esm';

// Предзагрузка @yowasp/clang сразу при загрузке страницы (105 MB качается заранее)
const clangPromise = import(CLANG_CDN).then(m => m, () => {});

/**
 * Проверить, использует ли код SystemC.
 */
function usesSystemC(code) {
  return code.includes('systemc.h')
    || code.includes('SC_MODULE')
    || code.includes('sc_main')
    || code.includes('sc_signal')
    || code.includes('sc_start');
}

/**
 * Сгенерировать обёртку для SC_MODULE: sc_main, сигналы, extern "C" экспорты.
 * @param {string} code — исходный код пользователя
 * @param {string} modName — имя модуля (из SC_MODULE)
 */
function wrapSystemC(code, modName) {
  return code + `
int sc_main(int, char*[]) { return 0; }
static sc_signal<bool>* clk_p; static sc_signal<bool>* rst_p; static sc_signal<bool>* en_p;
static sc_signal<sc_uint<4>>* q_p; static ${modName}* dut;
extern "C" {
void init() { if(dut)return;
  clk_p=new sc_signal<bool>("clk"); rst_p=new sc_signal<bool>("rst"); en_p=new sc_signal<bool>("en");
  q_p=new sc_signal<sc_uint<4>>("q"); dut=new ${modName}("dut");
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
 * Добавить скомпилированный WASM-модуль на визуальную канву.
 */
function addWasmToCanvas(exports, label, viz, GATES, addPaletteItem) {
  const typeId = 'wasm-module-' + Date.now();
  const pmm = {
    label,
    inputPins: ['in0','in1','in2','in3','in4','in5','in6','in7'],
    outputPins: ['out0','out1','out2','out3'],
    color: '#673AB7',
  };
  GATES[typeId] = pmm;
  if (addPaletteItem) addPaletteItem(typeId, pmm);
  viz.addElement(typeId, 300, 200);
  const lv = Array.from(viz.elementViews.values()).pop();
  if (!lv) return;
  lv.el.name = label;
  lv.el._evaluateFn = (inp, out) => {
    const v = exports.get_q ? exports.get_q() : 0;
    out.out0 = (v >> 0) & 1;
    out.out1 = (v >> 1) & 1;
    out.out2 = (v >> 2) & 1;
    out.out3 = (v >> 3) & 1;
  };
  lv.el._clockEdgeFn = (edge, inp, out) => {
    if (edge !== 'pos') return;
    if (exports.set_enable) exports.set_enable(inp.in1 ?? 0);
    const v = exports.step ? exports.step() : 0;
    out.out0 = (v >> 0) & 1;
    out.out1 = (v >> 1) & 1;
    out.out2 = (v >> 2) & 1;
    out.out3 = (v >> 3) & 1;
  };
  lv.el._resetFn = () => { if (exports.reset_ring) exports.reset_ring(); };
  viz._renderElement(lv);
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

// ═══ Предзагрузка WASM-чанков LLVM ═══════════════════════════════

async function prefetchLLVM(setProgress) {
  const CHUNKS = [
    'llvm.core.wasm', 'llvm.core2.wasm',
    'llvm.core3.wasm', 'llvm.core4.wasm',
  ];
  const BASE = 'https://cdn.jsdelivr.net/npm/@yowasp/clang/gen/';
  let total = 0, loaded = 0;

  const sizes = await Promise.all(CHUNKS.map(async (c) => {
    try {
      const r = await fetch(BASE + c, { method: 'HEAD' });
      return parseInt(r.headers.get('content-length') || '0', 10) || 25_000_000;
    } catch { return 25_000_000; }
  }));
  total = sizes.reduce((a, b) => a + b, 0);

  await Promise.all(CHUNKS.map(async (c) => {
    const r = await fetch(BASE + c);
    const rd = r.body.getReader();
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      loaded += value.length;
      if (setProgress) setProgress(loaded, total, `⬇ LLVM ${Math.round(loaded / total * 100)}%`);
    }
  }));
  if (setProgress) setProgress(total, total, '✅ LLVM загружен');
}

/**
 * Компиляция кода пользователя с линковкой к предсобранному systemc-unity.o.
 * Загружаем @yowasp/clang, unity.o, VFS-заголовки, компилируем main.cc, линкуем.
 */
async function compileSystemC(code, deps) {
  const { log, setStatus, setProgress = () => {} } = deps;

  setStatus('⏳ Загрузка компилятора...');
  log('⏳ Предзагрузка LLVM (105 MB)...', 'info');
  await prefetchLLVM(setProgress);
  log('✅ LLVM загружен', 'info');
  setStatus('⏳ Загрузка артефактов...');

  // Фаза 2: загружаем clang module + SystemC артефакты (70-85%)
  setProgress(70, 100, '⏳ Загрузка артефактов...');

  const [clangMod, coreResp, idsResp, vfsResp] = await Promise.all([
    clangPromise,
    fetch(SYSTEMC_CORE_O),
    fetch(SC_IDS_O),
    fetch(SYSTEMC_VFS_JSON),
  ]);
  const { runClang } = clangMod;
  const coreBuf = new Uint8Array(await coreResp.arrayBuffer());
  const idsBuf = new Uint8Array(await idsResp.arrayBuffer());
  const headersVFS = await vfsResp.json();

  // Обёртка для SC_MODULE
  let wrapCode = code;
  if (code.includes('SC_MODULE')) {
    const modName = (code.match(/SC_MODULE\s*\(\s*(\w+)\s*\)/) || [, 'user_module'])[1];
    wrapCode = wrapSystemC(code, modName);
  }

  setProgress(85, 100, '⚙ Компиляция...');
  log('⚙ Компиляция кода пользователя + линковка с SystemC...', 'info');
  setStatus('⏳ Компиляция...');

  const vfs = {
    'main.cc': wrapCode,
    'systemc-core.o': coreBuf,
    'sc_ids.o': idsBuf,
    ...headersVFS,
  };

  const args = [
    'clang++', 'main.cc', '-std=c++17',
    'systemc-core.o', 'sc_ids.o',
    '-o', 'module.wasm',
    '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable,--export=__wasm_call_ctors,--export-dynamic,--initial-memory=33554432',
    '--target=wasm32-wasip1', '-I.',
    '-O2',
    '-fvisibility=default',
    '-fno-threadsafe-statics',
    '-fno-exceptions',
    '-Wno-parentheses-equality',
    '-Wno-shift-count-overflow',
    '-Wno-deprecated',
  ];

  const result = await runClang(args, vfs);
  const wasmBuf = result['module.wasm'];
  if (!wasmBuf) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
    throw new Error(stderr || 'no wasm output');
  }

  return wasmBuf;
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

  const result = await runClang([
    'clang++', '-std=c++17', 'module.cc', '-o', 'module.wasm',
    '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable',
    '--target=wasm32-wasi', '-O2',
  ], { 'module.cc': code });

  const wasmBuf = result['module.wasm'];
  if (!wasmBuf) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
    throw new Error(stderr || 'no wasm output');
  }
  return wasmBuf;
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
    const wasmBuf = hasSysC
      ? await compileSystemC(code, deps)
      : await compilePlainCpp(code, deps);

    setProgress(95, 100, '⏳ Инстанциирование...');
    log('✅ Компиляция успешна, инстанциирование...', 'info');
    setStatus('⏳ Инстанциирование...');

    const exports = await instantiateWasm(wasmBuf, log);

    // Инициализация
    if (exports.init && exports.reset_ring) {
      exports.init();
      exports.reset_ring();
    }

    const label = hasSysC ? 'SysC' : 'Wasm';
    addWasmToCanvas(exports, label, deps.viz, deps.GATES, deps.addPaletteItem);
    setProgress(100, 100, '✅ Готово');
    setStatus(`✅ ${label} in-browser`);

  } catch (err) {
    log('❌ ' + (err.message || err), 'err');
    setStatus('❌ Ошибка');
    throw err;
  }
}
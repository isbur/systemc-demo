/**
 * Предкомпилированные SC_METHOD-элементы.
 * Один модуль на все типы, свой экземпляр (и своё ядро SystemC) на каждый блок канвы.
 */
import { makeWasiPreview1 } from './wasi.js';
import { setCellBinder } from './elements.js';

let compiled = null;

function readOutputs(el, exports) {
  for (let i = 0; i < el.outputPins.length; i++) {
    el.outputs[el.outputPins[i]] = exports.cell_get(i) ? 1 : 0;
  }
}

function attach(el) {
  if (!compiled || !el.cellType) return;
  const wasi = makeWasiPreview1(() => {});
  let instance;
  try {
    instance = new WebAssembly.Instance(compiled, { wasi_snapshot_preview1: wasi });
  } catch (error) {
    console.error('SystemC cell', el.type, error);
    return;
  }
  wasi._setMemory(instance.exports.memory);
  const exports = instance.exports;
  if (exports.__wasm_call_ctors) exports.__wasm_call_ctors();
  exports.cell_init(el.cellType);
  readOutputs(el, exports);
  el._cell = instance;
  el._evaluateFn = (inp, out) => {
    for (let i = 0; i < el.inputPins.length; i++) {
      exports.cell_set(i, inp[el.inputPins[i]] ? 1 : 0);
    }
    exports.cell_eval();
    for (let i = 0; i < el.outputPins.length; i++) {
      out[el.outputPins[i]] = exports.cell_get(i) ? 1 : 0;
    }
  };
  el._resetFn = () => {
    exports.cell_reset();
    if (el._sequential || el._isClock || el.inputPins.length === 0) readOutputs(el, exports);
  };
  el._dispose = () => { el._cell = null; };
}

export function installCellModule(module) {
  compiled = module;
  setCellBinder(attach);
}

export async function loadCells() {
  const response = await fetch(new URL('./cells/cells.wasm', import.meta.url));
  if (!response.ok) throw new Error('cells.wasm ' + response.status);
  const bytes = await response.arrayBuffer();
  installCellModule(await WebAssembly.compile(bytes));
  return bytes.byteLength;
}

export function cellSourceUrl(type, gates) {
  const file = gates[type]?.sourceFile;
  if (!file) return null;
  return new URL('./cells/' + file, import.meta.url).href;
}

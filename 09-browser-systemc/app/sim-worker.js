/**
 * Главный поток SystemC-модуля.
 * Команды приходят сообщениями с UI. thread-spawn уходит обратно на страницу:
 * этот worker в этот момент блокируется в Atomics.wait и не может создать вложенный Worker.
 */
import { createLog, makeImports, memoryLimits } from '../pthread-host/wasi.js';

let nextTid = 1;
let module;
let memory;
let log;
let stdin;
let instance;

function spawn(startArg) {
  const tid = nextTid++;
  self.postMessage({ type: 'spawn', module, memory, log, stdin, tid, startArg });
  return tid;
}

function reply(id, value, error) {
  self.postMessage(error ? { type: 'result', id, error } : { type: 'result', id, value });
}

self.onmessage = async (event) => {
  const data = event.data;
  try {
    if (data.type === 'load') {
      stdin = data.stdin;
      const bytes = data.wasm;
      module = await WebAssembly.compile(bytes);
      const limits = memoryLimits(bytes);
      memory = new WebAssembly.Memory(limits);
      log = createLog();
      instance = await WebAssembly.instantiate(module, makeImports(
        memory,
        spawn,
        log,
        stdin,
        (text) => self.postMessage({ type: 'stdout', text }),
      ));
      if (instance.exports.__wasm_call_ctors) instance.exports.__wasm_call_ctors();
      reply(data.id, 0);
      return;
    }
    if (data.type === 'call') {
      const fn = instance.exports[data.name];
      if (typeof fn !== 'function') throw new Error('нет экспорта ' + data.name);
      const value = fn(...(data.args || []));
      reply(data.id, value ?? 0);
    }
  } catch (error) {
    reply(data.id, 0, error.stack || error.message || String(error));
  }
};

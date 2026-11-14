/**
 * One OS thread for one wasi thread-spawn.
 * The same file runs in a browser Worker and in a Node worker_thread.
 * In the browser the page creates these workers: the main wasm worker is
 * blocked inside Atomics.wait and cannot host a nested Worker.
 */
import { makeImports } from './wasi.js';

let writeFd = null;
function err(text) {
  if (!writeFd) return;
  writeFd(2, text.endsWith('\n') ? text : text + '\n');
}

const node = typeof process !== 'undefined' && !!process.versions?.node;
const threads = new Set();
let nextTid = 1000;

function spawn(module, memory, log, stdin, startArg) {
  const tid = nextTid++;
  const worker = new globalThis.__NodeWorker(new URL('./thread.js', import.meta.url), { type: 'module' });
  threads.add(worker);
  worker.on('error', (error) => console.error('nested thread', error));
  worker.postMessage({ module, memory, log, stdin, tid, startArg });
  return tid;
}

async function boot({ module, memory, log, stdin, tid, startArg }) {
  const onWrite = (text) => {
    if (writeFd) writeFd(2, text);
    else self.postMessage({ type: 'stdout', text });
  };
  const instance = await WebAssembly.instantiate(
    module,
    makeImports(memory, (arg) => spawn(module, memory, log, stdin, arg), log, stdin, onWrite),
  );
  try {
    instance.exports.wasi_thread_start(tid, startArg);
  } catch (error) {
    let detail = error && (error.stack || String(error));
    if (node && error && typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.Exception) {
      const { inspect } = await import('node:util');
      detail = inspect(error, { depth: 4, breakLength: 120 });
    }
    err('thread trap ' + tid + ' ' + detail);
    if (error.exitCode === undefined) throw error;
  }
}

if (node) {
  const { parentPort, Worker } = await import('node:worker_threads');
  writeFd = (await import('node:fs')).writeSync;
  globalThis.__NodeWorker = Worker;
  parentPort.on('message', (data) => {
    boot(data).catch((error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
  });
  parentPort.on('messageerror', (error) => console.error('messageerror', error));
} else {
  self.onmessage = (event) => {
    boot(event.data).catch((error) => self.postMessage({ error: String(error && error.stack || error) }));
  };
}

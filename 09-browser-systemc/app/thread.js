/**
 * One OS thread for one wasi thread-spawn.
 * Lives next to coi-serviceworker.js so GitHub Pages / python http.server
 * serve it with COEP. A worker outside app/ cannot take SharedArrayBuffer.
 * The page creates these workers: the main wasm worker is blocked inside
 * Atomics.wait and cannot host a nested Worker.
 */
import { makeImports } from '../pthread-host/wasi.js';

let writeFd = null;
function err(text) {
  if (!writeFd) return;
  writeFd(2, text.endsWith('\n') ? text : text + '\n');
}

const node = typeof process !== 'undefined' && !!process.versions?.node;
const threads = new Set();
let nextTid = 1000;
let sendToParent = (msg) => {
  if (typeof self !== 'undefined' && self.postMessage) self.postMessage(msg);
};

function spawnWorker() {
  const url = new URL('./thread.js', import.meta.url);
  if (node) return new globalThis.__NodeWorker(url, { type: 'module' });
  return new Worker(url, { type: 'module' });
}

function spawn(module, memory, log, stdin, startArg) {
  const tid = nextTid++;
  const worker = spawnWorker();
  threads.add(worker);
  if (node) {
    worker.on('error', (error) => console.error('nested thread', error));
  } else {
    worker.onerror = (event) => {
      self.postMessage({ error: 'nested thread: ' + describeError(event) });
    };
    worker.onmessage = (message) => {
      if (message.data?.type === 'stdout') self.postMessage(message.data);
      else if (message.data?.error) self.postMessage(message.data);
    };
  }
  worker.postMessage({ module, memory, log, stdin, tid, startArg });
  return tid;
}

function describeError(event) {
  if (!event) return 'unknown error';
  if (typeof event === 'string') return event;
  const parts = [
    event.message,
    event.error && (event.error.message || event.error.stack || String(event.error)),
    event.filename && ('at ' + event.filename),
  ].filter(Boolean);
  return parts.join(' — ') || event.type || String(event);
}

async function boot({ module, memory, log, stdin, tid, startArg }) {
  if (!module || !memory) {
    throw new Error('pthread worker did not receive wasm module/memory');
  }
  const onWrite = (text) => {
    if (writeFd) writeFd(2, text);
    sendToParent({ type: 'stdout', text });
  };
  const instance = await WebAssembly.instantiate(
    module,
    makeImports(memory, (arg) => spawn(module, memory, log, stdin, arg), log, stdin, onWrite),
  );
  const start = instance.exports.wasi_thread_start;
  if (typeof start !== 'function') {
    throw new Error('wasi_thread_start is not exported');
  }
  try {
    start(tid, startArg);
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
  sendToParent = (msg) => parentPort.postMessage(msg);
  parentPort.on('message', (data) => {
    boot(data).catch((error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
  });
  parentPort.on('messageerror', (error) => console.error('messageerror', error));
} else {
  sendToParent = (msg) => self.postMessage(msg);
  self.onmessage = (event) => {
    boot(event.data).catch((error) => self.postMessage({ error: String(error && error.stack || error) }));
  };
}

/**
 * Сессия одного SystemC-модуля на стороне страницы.
 * UI шлёт call(), worker исполняет экспорт. stdin — общая кольцевая память.
 *
 * Worker pthread лежит в app/: coi-serviceworker.js ставит COEP
 * только на этот каталог. Без COEP SharedArrayBuffer в поток не доезжает.
 */
import { createStdin, writeStdin } from '../pthread-host/wasi.js';

const THREAD_WORKER = new URL('./thread.js', import.meta.url);

function describeWorkerError(event) {
  if (!event) return 'unknown error';
  const parts = [
    event.message,
    event.error && (event.error.message || event.error.stack || String(event.error)),
    event.filename && ('at ' + event.filename),
  ].filter(Boolean);
  return parts.join(' — ') || event.type || 'worker error';
}

export function createSimSession(logWasm, logError) {
  const stdin = createStdin();
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  const threads = new Set();
  let seq = 1;

  worker.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'stdout') {
      logWasm(data.text);
      return;
    }
    if (data.type === 'spawn') {
      const child = new Worker(THREAD_WORKER, { type: 'module' });
      threads.add(child);
      child.onerror = (error) => {
        logError('thread ' + data.tid + ': ' + describeWorkerError(error) + ' (' + THREAD_WORKER.href + ')');
      };
      child.onmessage = (message) => {
        if (message.data?.type === 'stdout') logWasm(message.data.text);
        else if (message.data?.error) logError('thread ' + data.tid + ': ' + message.data.error);
      };
      try {
        child.postMessage({
          module: data.module,
          memory: data.memory,
          log: data.log,
          stdin: data.stdin,
          tid: data.tid,
          startArg: data.startArg,
        });
      } catch (error) {
        logError('thread ' + data.tid + ': ' + (error.message || String(error)));
      }
      return;
    }
    if (data.type === 'result') {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.error) waiter.reject(new Error(data.error));
      else waiter.resolve(data.value);
    }
  };
  worker.onerror = (event) => logError(describeWorkerError(event));

  function request(message) {
    const id = seq++;
    message.id = id;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(message);
    });
  }

  return {
    async load(bytes) {
      await request({ type: 'load', wasm: bytes.slice(), stdin });
    },
    call(name, args = []) {
      return request({ type: 'call', name, args });
    },
    sample() {
      return request({ type: 'sample' });
    },
    pushStdin(text) {
      if (!writeStdin(stdin, text)) throw new Error('буфер stdin переполнен');
    },
    dispose() {
      const error = new Error('stopped');
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      worker.terminate();
      for (const child of threads) child.terminate();
      threads.clear();
    },
  };
}

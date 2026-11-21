/**
 * Сессия одного SystemC-модуля на стороне страницы.
 * UI шлёт call(), worker исполняет экспорт. stdin — общая кольцевая память.
 */
import { createStdin, writeStdin } from '../pthread-host/wasi.js';

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
      const child = new Worker(new URL('../pthread-host/thread.js', import.meta.url), { type: 'module' });
      threads.add(child);
      child.onerror = (error) => logError('thread ' + data.tid + ': ' + error.message);
      child.onmessage = (message) => {
        if (message.data?.type === 'stdout') logWasm(message.data.text);
        else if (message.data?.error) logError('thread ' + data.tid + ': ' + message.data.error);
      };
      child.postMessage({
        module: data.module,
        memory: data.memory,
        log: data.log,
        stdin: data.stdin,
        tid: data.tid,
        startArg: data.startArg,
      });
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
  worker.onerror = (event) => logError(event.message || 'worker error');

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

/**
 * Instantiate one linked canvas circuit.
 * The page drives it from sim-worker.js. Headless tests call this directly.
 */
import { createLog, createStdin, makeImports, memoryLimits } from '../pthread-host/wasi.js';

export async function instantiateCircuit(wasmBytes, hooks = {}) {
  const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
  const limits = memoryLimits(bytes);
  const memory = new WebAssembly.Memory(limits);
  const log = createLog();
  const stdin = hooks.stdin || createStdin();
  const module = await WebAssembly.compile(bytes);
  let nextTid = 1;
  const spawn = (startArg) => {
    const tid = nextTid++;
    if (!hooks.spawn) throw new Error('thread-spawn is not available');
    return hooks.spawn({ module, memory, log, stdin, tid, startArg });
  };
  const instance = await WebAssembly.instantiate(module, makeImports(
    memory,
    spawn,
    log,
    stdin,
    (text) => hooks.onStdout?.(text),
  ));
  if (instance.exports.__wasm_call_ctors) instance.exports.__wasm_call_ctors();
  return { instance, exports: instance.exports, memory, stdin, module, log };
}

export function readSample(exports, memory) {
  const n = exports.circuit_sample() | 0;
  const values = n
    ? Array.from(new Int32Array(memory.buffer, exports.circuit_sample_ptr(), n))
    : [];
  const raw = exports.circuit_time_ps();
  const timePs = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  return {
    values,
    timePs,
    timeNs: timePs / 1000,
    status: exports.circuit_status() | 0,
    deltas: exports.circuit_deltas() | 0,
  };
}

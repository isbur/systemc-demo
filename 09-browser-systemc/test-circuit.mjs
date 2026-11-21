/**
 * Headless simulation of one canvas-wide SystemC kernel, plus incremental build.
 * Prints cold and incremental times.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { runClang } from '@yowasp/clang';
import { compileCircuit } from './app/circuit-build.js';
import { instantiateCircuit, readSample } from './app/circuit-run.js';
import { generateCircuit } from './app/netlist.js';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);
const cacheDir = join(root, '.cache', 'circuit-objects');
mkdirSync(cacheDir, { recursive: true });

function fileCache(dir) {
  const memory = new Map();
  return {
    async get(key) {
      if (memory.has(key)) return memory.get(key);
      try {
        const bytes = new Uint8Array(readFileSync(join(dir, key.replaceAll(':', '_'))));
        memory.set(key, bytes);
        return bytes;
      } catch {
        return null;
      }
    },
    async set(key, bytes) {
      const copy = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      memory.set(key, copy);
      writeFileSync(join(dir, key.replaceAll(':', '_')), copy);
    },
  };
}

function loadBytes(path) {
  return new Uint8Array(readFileSync(path));
}

const sources = { 'circuit-rt.cpp': readFileSync(join(root, 'app/circuit-rt.cpp'), 'utf8') };
for (const name of [
  'vcc.cpp', 'gnd.cpp', 'and.cpp', 'or.cpp', 'not.cpp', 'nand.cpp', 'nor.cpp', 'xor.cpp',
  'dff.cpp', 'ring4.cpp', 'counter4.cpp', 'mux2.cpp', 'mux4.cpp', 'half_adder.cpp',
]) {
  sources[name] = readFileSync(join(root, 'app/cells', name), 'utf8');
}

const env = {
  runClang,
  headers: JSON.parse(readFileSync(join(root, 'app/systemc-vfs.json'), 'utf8')),
  include: JSON.parse(readFileSync(join(repo, 'wasi-include.json'), 'utf8')),
  libs: {
    'libc.a': loadBytes(join(root, 'pthread-host/wasi/libc.a')),
    'libpthread.a': loadBytes(join(root, 'pthread-host/wasi/libpthread.a')),
    'crt1.o': loadBytes(join(root, 'pthread-host/wasi/crt1.o')),
    'libc++.a': loadBytes(join(root, 'pthread-host/wasi/eh/libc++.a')),
    'libc++abi.a': loadBytes(join(root, 'pthread-host/wasi/eh/libc++abi.a')),
    'libunwind.a': loadBytes(join(root, 'pthread-host/wasi/eh/libunwind.a')),
    'libclang_rt.builtins.a': loadBytes(join(root, 'pthread-host/wasi/libclang_rt.builtins.a')),
  },
  core: loadBytes(join(root, 'pthread-host/systemc-core-pthread.o')),
  ids: loadBytes(join(root, 'pthread-host/sc_ids-pthread.o')),
  sources,
};

const cache = fileCache(cacheDir);
const workers = new Set();

function spawn(payload) {
  const worker = new Worker(new URL('./app/thread.js', import.meta.url), { type: 'module' });
  workers.add(worker);
  worker.on('error', (error) => console.error('thread', error));
  worker.postMessage(payload);
  return payload.tid;
}

async function build(model) {
  const gen = generateCircuit(model);
  assert.equal(gen.error, null, gen.error || '');
  const started = Date.now();
  const built = await compileCircuit(gen, env, cache);
  const misses = built.stats.units.filter((unit) => unit.result === 'miss');
  const hits = built.stats.units.filter((unit) => unit.result === 'hit').map((unit) => unit.id);
  console.log(
    `build ${Date.now() - started} ms  cold=${built.stats.cold}  `
    + `compile ${misses.map((unit) => unit.id + ':' + Math.round(unit.ms) + 'ms').join('+') || '-'}  `
    + `cache ${hits.join('+') || '-'}  link ${built.stats.link.result} ${Math.round(built.stats.link.ms)} ms`,
  );
  return { ...built, gen };
}

async function boot(built) {
  const log = [];
  const session = await instantiateCircuit(built.wasm, { onStdout: (text) => log.push(text), spawn });
  let initStatus;
  try {
    initStatus = session.exports.circuit_init();
  } catch (error) {
    throw new Error('circuit_init failed: ' + error + '\n' + log.join(''));
  }
  return { ...session, log, initStatus, sample: readSample(session.exports, session.memory) };
}

function level(sample, manifest, uid, pin) {
  const id = manifest.byPin[String(uid)][pin];
  assert.notEqual(id, undefined, uid + '.' + pin);
  return sample.values[id];
}

const BUF = `#include "systemc.h"
SC_MODULE(Buf) {
  sc_in<bool> a;
  sc_out<bool> y;
  void eval() { y.write(a.read()); }
  SC_CTOR(Buf) { SC_METHOD(eval); sensitive << a; }
};
`;
const BUF_CHANGED = BUF.replace('y.write(a.read())', 'y.write(a.read() && true)');
const NIBBLE = `#include "systemc.h"
SC_MODULE(Nibble) {
  sc_in<bool> clk;
  sc_in<bool> rst_n;
  sc_in<bool> enable;
  sc_out<sc_uint<4>> q;
  sc_uint<4> n = 0;
  void eval() {
    if (clk.posedge() && enable.read()) n = n + 1;
    q.write(n);
  }
  SC_CTOR(Nibble) { SC_METHOD(eval); sensitive << clk; }
};
`;

console.log('--- combinational VCC → AND → NOT ---');
const combo = await build({
  elements: [{ uid: '1', type: 'VCC' }, { uid: '2', type: 'AND' }, { uid: '3', type: 'NOT' }],
  connections: [
    { id: 1, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'a' },
    { id: 2, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'b' },
    { id: 3, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'a' },
  ],
});
{
  const session = await boot(combo);
  assert.equal(session.initStatus, 0, session.log.join(''));
  assert.equal(session.sample.timePs, 0);
  assert.equal(level(session.sample, combo.gen.manifest, 2, 'y'), 1);
  assert.equal(level(session.sample, combo.gen.manifest, 3, 'y'), 0);
  session.exports.circuit_step();
  const stepped = readSample(session.exports, session.memory);
  assert.equal(stepped.timePs, 5000);
  assert.equal(level(stepped, combo.gen.manifest, 2, 'y'), 1);
}

console.log('--- identical rebuild is entirely cached ---');
const comboAgain = await build({
  elements: [{ uid: '1', type: 'VCC' }, { uid: '2', type: 'AND' }, { uid: '3', type: 'NOT' }],
  connections: [
    { id: 1, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'a' },
    { id: 2, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'b' },
    { id: 3, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'a' },
  ],
});
assert.ok(comboAgain.stats.units.every((unit) => unit.result === 'hit'));
assert.equal(comboAgain.stats.link.result, 'hit');

console.log('--- counter on a real sc_clock ---');
const counter = await build({
  elements: [
    { uid: '1', type: 'CLOCK' },
    { uid: '2', type: 'VCC' },
    { uid: '3', type: 'COUNTER4' },
  ],
  connections: [
    { id: 1, fromUid: '1', fromPin: 'clk', toUid: '3', toPin: 'clk' },
    { id: 2, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'enable' },
    { id: 3, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'rst_n' },
  ],
});
{
  const session = await boot(counter);
  assert.equal(session.initStatus, 0, session.log.join(''));
  assert.equal(level(session.sample, counter.gen.manifest, 1, 'clk'), 0);
  assert.equal(level(session.sample, counter.gen.manifest, 3, 'q0'), 0);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    assert.equal(session.exports.circuit_step(), 0);
    const sample = readSample(session.exports, session.memory);
    seen.push({
      t: sample.timePs,
      clk: level(sample, counter.gen.manifest, 1, 'clk'),
      q0: level(sample, counter.gen.manifest, 3, 'q0'),
      q1: level(sample, counter.gen.manifest, 3, 'q1'),
    });
  }
  console.log('counter', JSON.stringify(seen));
  assert.deepEqual(seen.map((row) => row.clk), [1, 0, 1, 0, 1, 0]);
  assert.deepEqual(seen.map((row) => row.q0), [1, 1, 0, 0, 1, 1]);
  assert.deepEqual(seen.map((row) => row.q1), [0, 0, 1, 1, 1, 1]);
  assert.deepEqual(seen.map((row) => row.t), [5000, 10000, 15000, 20000, 25000, 30000]);
}

console.log('--- user module mixed with cells ---');
const mixed = await build({
  elements: [
    { uid: '1', type: 'VCC' },
    { uid: '2', type: 'wasm', source: BUF },
    { uid: '3', type: 'NOT' },
  ],
  connections: [
    { id: 4, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'a' },
    { id: 5, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'a' },
  ],
});
{
  const session = await boot(mixed);
  assert.equal(session.initStatus, 0, session.log.join(''));
  assert.equal(level(session.sample, mixed.gen.manifest, 2, 'y'), 1);
  assert.equal(level(session.sample, mixed.gen.manifest, 3, 'y'), 0);
}

console.log('--- changing one module does not recompile the others ---');
const mixedAgain = await build({
  elements: [
    { uid: '1', type: 'VCC' },
    { uid: '2', type: 'wasm', source: BUF_CHANGED },
    { uid: '3', type: 'NOT' },
  ],
  connections: [
    { id: 4, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'a' },
    { id: 5, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'a' },
  ],
});
{
  const misses = mixedAgain.stats.units.filter((unit) => unit.result === 'miss').map((unit) => unit.id);
  const hits = new Set(mixedAgain.stats.units.filter((unit) => unit.result === 'hit').map((unit) => unit.id));
  console.log('incremental misses', misses.join(', '));
  assert.deepEqual(misses, ['mod_mk_usr_Buf']);
  assert.ok(hits.has('cell_Vcc') && hits.has('cell_Not') && hits.has('runtime') && hits.has('top'));
  assert.equal(mixedAgain.stats.link.result, 'miss');
  const session = await boot(mixedAgain);
  assert.equal(level(session.sample, mixedAgain.gen.manifest, 3, 'y'), 0);
}

console.log('--- canvas sc_uint module shares the clock ---');
const nibble = await build({
  elements: [
    { uid: '1', type: 'CLOCK' },
    { uid: '2', type: 'VCC' },
    { uid: '3', type: 'wasm', source: NIBBLE },
  ],
  connections: [
    { id: 1, fromUid: '1', fromPin: 'clk', toUid: '3', toPin: 'clk' },
    { id: 2, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'enable' },
  ],
});
{
  const session = await boot(nibble);
  assert.equal(session.initStatus, 0, session.log.join(''));
  assert.equal(session.exports.circuit_step(), 0);
  let sample = readSample(session.exports, session.memory);
  assert.equal(level(sample, nibble.gen.manifest, 3, 'q0'), 1);
  assert.equal(session.exports.circuit_step(), 0);
  assert.equal(session.exports.circuit_step(), 0);
  sample = readSample(session.exports, session.memory);
  assert.equal(level(sample, nibble.gen.manifest, 3, 'q0'), 0);
  assert.equal(level(sample, nibble.gen.manifest, 3, 'q1'), 1);
}

console.log('--- NOT self-loop stops on the delta-cycle limit ---');
const loop = await build({
  elements: [{ uid: '1', type: 'NOT' }],
  connections: [{ id: 7, fromUid: '1', fromPin: 'y', toUid: '1', toPin: 'a' }],
});
{
  const session = await boot(loop);
  console.log('loop', session.initStatus, 'deltas', session.sample.deltas, 't', session.sample.timePs, 'log', session.log.join('').slice(0, 300));
  assert.equal(session.initStatus, 1);
  assert.equal(session.sample.timePs, 0);
  assert.ok(session.sample.deltas >= 10000, 'deltas ' + session.sample.deltas);
  assert.equal(session.exports.circuit_step(), 1);
  assert.equal(readSample(session.exports, session.memory).timePs, 0);
}

for (const worker of workers) await worker.terminate();
console.log('circuit tests passed');

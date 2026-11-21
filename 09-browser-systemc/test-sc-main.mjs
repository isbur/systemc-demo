/**
 * sc_main with SC_THREAD must spawn a wasi pthread and print through fd_write.
 * The editor compiles this path separately from the canvas kernel.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { runClang } from '@yowasp/clang';
import { instantiateCircuit } from './app/circuit-run.js';
import { editorClangArgs } from './app/pthread-link.js';
import { wasiSysroot } from './app/toolchain.js';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

function loadBytes(path) {
  return new Uint8Array(readFileSync(path));
}

const libs = {
  'libc.a': loadBytes(join(root, 'pthread-host/wasi/libc.a')),
  'libpthread.a': loadBytes(join(root, 'pthread-host/wasi/libpthread.a')),
  'crt1.o': loadBytes(join(root, 'pthread-host/wasi/crt1.o')),
  'libc++.a': loadBytes(join(root, 'pthread-host/wasi/eh/libc++.a')),
  'libc++abi.a': loadBytes(join(root, 'pthread-host/wasi/eh/libc++abi.a')),
  'libunwind.a': loadBytes(join(root, 'pthread-host/wasi/eh/libunwind.a')),
  'libclang_rt.builtins.a': loadBytes(join(root, 'pthread-host/wasi/libclang_rt.builtins.a')),
};

const source = `#include "systemc.h"
SC_MODULE(Hello) {
  void run() {
    std::cout << "hello-thread" << std::endl;
  }
  SC_CTOR(Hello) { SC_THREAD(run); }
};
int sc_main(int, char*[]) {
  Hello hello("hello");
  sc_start(SC_ZERO_TIME);
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

const vfs = {
  'main.cc': source,
  'systemc-core.o': loadBytes(join(root, 'pthread-host/systemc-core-pthread.o')),
  'sc_ids.o': loadBytes(join(root, 'pthread-host/sc_ids-pthread.o')),
  ...JSON.parse(readFileSync(join(root, 'app/systemc-vfs.json'), 'utf8')),
  sysroot: wasiSysroot(
    JSON.parse(readFileSync(join(repo, 'wasi-include.json'), 'utf8')),
    libs,
    true,
  ),
};

let clangLog = '';
const started = Date.now();
const result = await runClang(editorClangArgs(), vfs, {
  stderr: (bytes) => { if (bytes) clangLog += new TextDecoder().decode(bytes); },
});
const wasm = result['module.wasm'];
if (!wasm) {
  throw new Error(clangLog.slice(-2000) || 'no module.wasm');
}
console.log('compiled sc_main in', Date.now() - started, 'ms');

const workers = new Set();
function spawn(payload) {
  const worker = new Worker(new URL('./app/thread.js', import.meta.url), { type: 'module' });
  workers.add(worker);
  worker.on('error', (error) => console.error('thread', error));
  worker.on('message', (message) => {
    if (message?.type === 'stdout') log.push(message.text);
    else if (message?.error) console.error('thread', message.error);
  });
  worker.postMessage(payload);
  return payload.tid;
}

const log = [];
const hung = setTimeout(() => {
  console.error('sc_main hung\n' + log.join(''));
  process.exit(1);
}, 30000);

const session = await instantiateCircuit(wasm, {
  onStdout: (text) => log.push(text),
  spawn,
});
assert.equal(typeof session.exports.init, 'function');
assert.equal(typeof session.exports.wasi_thread_start, 'function');

let status;
try {
  status = session.exports.init();
} catch (error) {
  clearTimeout(hung);
  throw new Error('init failed: ' + error + '\n' + log.join(''));
}

const deadline = Date.now() + 2000;
while (!log.join('').includes('hello-thread') && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
clearTimeout(hung);

const text = log.join('');
console.log('sc_main status', status, 'stdout', JSON.stringify(text));
assert.equal(status, 0, text);
assert.match(text, /hello-thread/);

for (const worker of workers) await worker.terminate();
console.log('sc_main pthread test passed');

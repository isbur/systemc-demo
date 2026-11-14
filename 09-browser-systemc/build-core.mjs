#!/usr/bin/env node
// Quick rebuild of systemc-core.o with WASM coroutine stub
import { runClang } from '@yowasp/clang';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'app', 'systemc-src');
const OUT = join(__dirname, 'app');

function scan(dir) {
  const t = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) t[e.name] = scan(fp);
    else if (e.isFile() && (['h','hpp','cpp'].includes(e.name.split('.').pop()) || e.name === 'systemc' || e.name === 'systemc.h' || e.name === 'tlm' || e.name === 'tlm.h'))
      t[e.name] = readFileSync(fp, 'utf-8');
  }
  return t;
}

const all = scan(SRC);

// Add WASM coroutine stub
all.sysc.kernel['sc_cor_wasm.h'] = `#ifndef SC_COR_WASM_H
#define SC_COR_WASM_H
#include "sysc/kernel/sc_cor.h"
namespace sc_core {
class sc_cor_wasm : public sc_cor {};
class sc_cor_pkg_wasm : public sc_cor_pkg {
public:
  sc_cor_pkg_wasm(sc_simcontext* simc) : sc_cor_pkg(simc) {}
  sc_cor* create(std::size_t, sc_cor_fn*, void*) override { return nullptr; }
  void yield(sc_cor*) override {}
  void abort(sc_cor*) override {}
  sc_cor* get_main() override { return &m_main; }
private: sc_cor_wasm m_main;
};
typedef sc_cor_pkg_wasm sc_cor_pkg_t;
}
#endif
`;

all.sysc.kernel['sc_cor_wasm.cpp'] = '#include "sysc/kernel/sc_cor_wasm.h"\n';

// Patch sc_simcontext.cpp
let sim = all.sysc.kernel['sc_simcontext.cpp'];
sim = sim.replace(/#include "sysc\/kernel\/sc_cor_\w+\.h"\s*\n/g, '');
sim = sim.replace(
  '#include "sysc/kernel/sc_event.h"',
  '#include "sysc/kernel/sc_cor_wasm.h"\n#include "sysc/kernel/sc_event.h"'
);
all.sysc.kernel['sc_simcontext.cpp'] = sim;

// Collect .cpp files (exclude sc_utils_ids.cpp and all real coroutines)
const exclude = ['sc_utils_ids.cpp', 'sc_cor_pthread.cpp', 'sc_cor_qt.cpp', 'sc_cor_fiber.cpp', 'sc_cor_std_thread.cpp', 'sc_cor_counted.cpp'];
const cppFiles = [];
function collect(tree, prefix = '') {
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? prefix + '/' + k : k;
    if (typeof v === 'string') { if (k.endsWith('.cpp') && !exclude.some(e => k.endsWith(e))) cppFiles.push(p); }
    else collect(v, p);
  }
}
collect(all);
cppFiles.push('sysc/kernel/sc_cor_wasm.cpp');

// Build core.cc
let cc = '#include "systemc.h"\n';
cc += 'extern "C" {\n';
cc += '  void* __cxa_allocate_exception(unsigned long s) { return new char[s?s:1]; }\n';
cc += '  void __cxa_throw(void* a,void*,void(*)(void*)) { (void)a; __builtin_trap(); }\n';
cc += '  void __cxa_rethrow() { __builtin_trap(); }\n';
cc += '  void* __cxa_begin_catch(void* p) { return p; }\n';
cc += '  void  __cxa_end_catch() {}\n';
cc += '  void* __cxa_get_exception_ptr(void* p) { return p; }\n';
cc += '}\n';
for (const c of cppFiles) cc += `#include "${c}"\n`;

console.log(`core.cc: ${cppFiles.length} files, ${(Buffer.byteLength(cc)/1024).toFixed(0)} KB`);

const vfs = { 'core.cc': cc, ...all };

const r = await runClang([
  'clang++', '-std=c++17', '-c', 'core.cc', '-o', 'systemc-core.o',
  '--target=wasm32-wasip1', '-I.', '-O2',
  '-fvisibility=default', '-fno-threadsafe-statics',
], vfs, { timeout: 120000 });

const buf = r['systemc-core.o'];
if (!buf) {
  throw new Error('No output');
}
const outPath = join(OUT, 'systemc-core.o');
writeFileSync(outPath, Buffer.from(buf));
console.log(`✅ ${outPath} (${(buf.byteLength/1024/1024).toFixed(1)} MB)`);
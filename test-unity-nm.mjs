#!/usr/bin/env node
// Compile exactly the same unity.cc as build-artifacts.mjs, check SC_ID symbols
import { runClang, runLLVM } from '@yowasp/clang';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'app', 'systemc-src');

function scanAll(dir) {
  const t = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) t[e.name] = scanAll(fp);
    else if (e.isFile() && (['h','hpp','cpp'].includes(e.name.split('.').pop()) || e.name === 'systemc' || e.name === 'systemc.h' || e.name === 'tlm' || e.name === 'tlm.h'))
      t[e.name] = readFileSync(fp, 'utf-8');
  }
  return t;
}

function collectCpp(tree, prefix = '') {
  let files = [];
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? `${prefix}/${k}` : k;
    if (typeof v === 'string') { if (k.endsWith('.cpp')) files.push(p); }
    else files = files.concat(collectCpp(v, p));
  }
  return files;
}

const all = scanAll(SRC);
const cppFiles = collectCpp(all).filter(f =>
  !['sc_cor_pthread.cpp', 'sc_cor_qt.cpp', 'sc_cor_counted.cpp'].some(p => f.endsWith(p))
);

// Build unity.cc same as build-artifacts.mjs
let unity = `#include "systemc.h"\n
extern "C" {
  void* __cxa_allocate_exception(unsigned long s) { return new char[s ? s : 1]; }
  void __cxa_throw(void* obj, void*, void (*)(void*)) { (void)obj; __builtin_trap(); }
  void* __cxa_begin_catch(void* p) { return p; }
  void  __cxa_end_catch() {}
  void* __cxa_get_exception_ptr(void* p) { return p; }
}
`;
for (const cpp of cppFiles) unity += `#include "${cpp}"\n`;

const vfs = { 'unity.cc': unity, ...all };

console.log(`unity.cc: ${cppFiles.length} cpp files, ${(Buffer.byteLength(unity)/1024).toFixed(0)} KB`);

const r = await runClang([
  'clang++', '-std=c++17', '-c', 'unity.cc', '-o', 'unity.o',
  '--target=wasm32-wasip1', '-I.', '-O2',
  '-fvisibility=default', '-fno-threadsafe-statics', '-DSC_USE_PTHREADS',
  '-Wno-parentheses-equality', '-Wno-shift-count-overflow', '-Wno-deprecated',
], vfs);

const obj = r['unity.o'];
if (!obj) {
  const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : '';
  console.error('FAIL:', stderr.substring(0, 2000));
  process.exit(1);
}
console.log(`Object: ${(obj.byteLength/1024/1024).toFixed(1)} MB`);

// Check SC_ID symbols
const r2 = await runLLVM(['nm', 'unity.o'], { 'unity.o': new Uint8Array(obj) });
const out = r2.stdout ? new TextDecoder().decode(r2.stdout) : '';
const idLines = out.split('\n').filter(l => l.includes('SC_ID'));
const defined = idLines.filter(l => !l.includes(' U '));
const undefined = idLines.filter(l => l.includes(' U '));
console.log(`SC_ID defined: ${defined.length}, undefined: ${undefined.length}`);
if (undefined.length > 0) undefined.slice(0,5).forEach(l => console.log('  UNDEF:', l.trim()));
if (defined.length > 0) defined.slice(0,3).forEach(l => console.log('  DEF:', l.trim()));

// Also check what wasm-ld would complain about
const undefinedAll = out.split('\n').filter(l => l.includes(' U '));
console.log(`\nTotal undefined symbols: ${undefinedAll.length}`);
undefinedAll.slice(0,10).forEach(l => console.log('  U:', l.trim()));
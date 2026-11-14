#!/usr/bin/env node
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
    else if (e.isFile() && ['h','hpp','cpp'].includes(e.name.split('.').pop()) || e.name === 'systemc' || e.name === 'systemc.h')
      t[e.name] = readFileSync(fp, 'utf-8');
  }
  return t;
}

const all = scanAll(SRC);

// Compile sc_utils_ids.cpp to .o
const vfs1 = {
  'test.cc': '#include "sysc/utils/sc_utils_ids.cpp"\n',
  ...all,
};

console.log('Compiling sc_utils_ids.cpp...');
const r1 = await runClang([
  'clang++', '-std=c++17', '-c', 'test.cc', '-o', 'test.o',
  '--target=wasm32-wasip1', '-I.', '-DSC_USE_PTHREADS',
  '-fvisibility=default', '-fno-threadsafe-statics',
], vfs1);

const objBuf = r1['test.o'];
if (!objBuf) {
  const stderr = r1.stderr ? new TextDecoder().decode(r1.stderr) : '';
  console.error('Compile failed:', stderr.substring(0,1000));
  process.exit(1);
}
console.log(`Object size: ${objBuf.byteLength} bytes`);

// Run nm on the object
const r2 = await runLLVM(['nm', 'test.o'], { 'test.o': new Uint8Array(objBuf) });
const stdout = r2.stdout ? new TextDecoder().decode(r2.stdout) : '';
const stderr = r2.stderr ? new TextDecoder().decode(r2.stderr) : '';

if (stderr) console.log('NM stderr:', stderr.substring(0,500));

// Filter SC_ID symbols
const lines = stdout.split('\n').filter(l => l.includes('SC_ID'));
console.log(`\nSC_ID symbols found: ${lines.length}`);
lines.forEach(l => console.log('  ' + l.trim()));

// Also show all DATA symbols
console.log('\nAll data symbols:');
stdout.split('\n').filter(l => l.includes(' D ') || l.includes(' d ')).slice(0, 30).forEach(l => console.log('  ' + l.trim()));
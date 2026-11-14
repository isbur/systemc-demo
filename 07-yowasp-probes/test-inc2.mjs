#!/usr/bin/env node
/**
 * Test: find the minimal VFS that reproduces the FP_NAN error.
 * Start with just systemc.h, add sysc headers incrementally.
 */
import { runClang } from '@yowasp/clang';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function readFile(p) { return readFileSync(join('systemc-src/src', p), 'utf-8'); }

// Base VFS: only systemc.h and the 'systemc' linker file
function testVFS(vfs) {
  const test = { ...vfs, 'test.cpp': '#include "systemc.h"\nint x;' };
  try {
    const r = runClang(['clang++', '-std=c++17', '--target=wasm32-wasi', '-I.', '-c', '-o', '/dev/null', 'test.cpp'], test);
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : '';
    if (stderr.includes('error:')) {
      const errs = stderr.split('\n').filter(l => l.includes('error:'));
      return { ok: false, errors: errs.length, first: errs[0] };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 100) };
  }
}

// Start with base
let vfs = { 'systemc.h': readFile('systemc.h'), 'systemc': readFile('systemc') };
console.log('Base (systemc.h only):', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add sysc/kernel directory headers
const kernelHeaders = readdirSync('systemc-src/src/sysc/kernel').filter(f => f.endsWith('.h') || f.endsWith('.hpp'));
const kernelDir = {};
for (const f of kernelHeaders) kernelDir[f] = readFileSync(join('systemc-src/src/sysc/kernel', f), 'utf-8');

vfs = { 'systemc.h': readFile('systemc.h'), 'systemc': readFile('systemc'), 'sysc': { 'kernel': kernelDir } };
console.log('+sysc/kernel headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add sysc/communication headers
const commHeaders = readdirSync('systemc-src/src/sysc/communication').filter(f => f.endsWith('.h') || f.endsWith('.hpp'));
const commDir = {};
for (const f of commHeaders) commDir[f] = readFileSync(join('systemc-src/src/sysc/communication', f), 'utf-8');
vfs.sysc['communication'] = commDir;
console.log('+sysc/communication headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add sysc/datatypes headers
const dtDir = {};
for (const sub of readdirSync('systemc-src/src/sysc/datatypes')) {
  const sp = join('systemc-src/src/sysc/datatypes', sub);
    const files = readdirSync(sp).filter(f => f.endsWith('.h'));
    const d = {}; for (const f of files) d[f] = readFileSync(join(sp, f), 'utf-8');
    dtDir[sub] = d;
  } else if (sub.endsWith('.h')) {
    dtDir[sub] = readFileSync(join('systemc-src/src/sysc/datatypes', sub), 'utf-8');
  }
}
vfs.sysc['datatypes'] = dtDir;
console.log('+sysc/datatypes headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add sysc/utils headers
const utilsDir = {};
for (const f of readdirSync('systemc-src/src/sysc/utils').filter(f => f.endsWith('.h') || f.endsWith('.hpp')))
  utilsDir[f] = readFileSync(join('systemc-src/src/sysc/utils', f), 'utf-8');
vfs.sysc['utils'] = utilsDir;
console.log('+sysc/utils headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add sysc/tracing headers
const tracingDir = {};
for (const f of readdirSync('systemc-src/src/sysc/tracing').filter(f => f.endsWith('.h') || f.endsWith('.hpp')))
  tracingDir[f] = readFileSync(join('systemc-src/src/sysc/tracing', f), 'utf-8');
vfs.sysc['tracing'] = tracingDir;
console.log('+sysc/tracing headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add sysc/packages headers
function walkAdd(tree, dirPath, vfsPrefix) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = {};
      walkAdd(sub, join(dirPath, entry.name), join(vfsPrefix, entry.name));
      tree[entry.name] = sub;
    } else if (entry.isFile() && (entry.name.endsWith('.h') || entry.name.endsWith('.hpp'))) {
      tree[entry.name] = readFileSync(join(dirPath, entry.name), 'utf-8');
    }
  }
}
const packagesDir = {};
walkAdd(packagesDir, 'systemc-src/src/sysc/packages', 'sysc/packages');
vfs.sysc['packages'] = packagesDir;
console.log('+sysc/packages headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

// Add tlm headers
for (const f of readdirSync('systemc-src/src/tlm_core/tlm_2/tlm_2_interfaces').filter(f => f.endsWith('.h'))) {
  const d = {};
  d[f] = readFileSync(join('systemc-src/src/tlm_core/tlm_2/tlm_2_interfaces', f), 'utf-8');
  if (!vfs.tlm_core) vfs.tlm_core = {};
  if (!vfs.tlm_core.tlm_2) vfs.tlm_core.tlm_2 = {};
  if (!vfs.tlm_core.tlm_2['tlm_2_interfaces']) vfs.tlm_core.tlm_2['tlm_2_interfaces'] = {};
  vfs.tlm_core.tlm_2['tlm_2_interfaces'][f] = readFileSync(join('systemc-src/src/tlm_core/tlm_2/tlm_2_interfaces', f), 'utf-8');
}
console.log('+tlm headers:', testVFS(vfs).ok ? 'PASS' : 'FAIL');

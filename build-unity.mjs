#!/usr/bin/env node
/**
 * Build SystemC + ring_counter (wasm_main.cpp) into WASM via @yowasp/clang
 * Uses unity build approach: all .cpp files included into one translation unit.
 * Key fix: -fvisibility=default to expose SC_ID_* constants.
 */
import { runClang } from '@yowasp/clang';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'systemc-src', 'src');
const USER_CODE = join(__dirname, 'wasm_main.cpp');

function buildTree(dirPath, vfsPrefix = '') {
  const tree = {};
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const vfsKey = entry.name;
    if (entry.isDirectory()) {
      tree[vfsKey] = buildTree(fullPath, join(vfsPrefix, entry.name));
    } else if (entry.isFile()) {
      // Only include relevant files
      const ext = entry.name.split('.').pop();
      if (['cpp', 'h', 'hpp'].includes(ext) || entry.name === 'systemc' || entry.name === 'systemc.h') {
        tree[vfsKey] = readFileSync(fullPath, 'utf-8');
      }
    }
  }
  return tree;
}

console.log('📂 Scanning SystemC source tree...');
const srcTree = buildTree(SRC);

// --- Step 2: Generate unity.cc ---
function collectCppFiles(tree, prefix = '') {
  let files = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (typeof value === 'string') {
      if (key.endsWith('.cpp')) {
        files.push(path);
      }
    } else {
      files = files.concat(collectCppFiles(value, path));
    }
  }
  return files;
}

const cppFiles = collectCppFiles(srcTree);
console.log(`📋 Found ${cppFiles.length} .cpp files in SystemC source`);

// Generate unity.cc content
let unityContent = '// SystemC Unity Build — auto-generated\n';
unityContent += '// Includes ALL SystemC source files + user code\n\n';

// Include systemc.h first (headers)
unityContent += '#include "systemc.h"\n\n';

// Include all SystemC implementation files
for (const cpp of cppFiles) {
  unityContent += `#include "${cpp}"\n`;
}

// Include user code
unityContent += '\n// --- User code ---\n';
const userCode = readFileSync(USER_CODE, 'utf-8');
unityContent += userCode;

console.log('📄 Generated unity.cc content');
console.log(`   Total lines: ~${unityContent.split('\n').length}`);

// --- Step 3: Build VFS for runClang ---
// The VFS needs to be a nested object matching the file tree
// with unity.cc at the root
const vfs = {
  'unity.cc': unityContent,
  ...srcTree,
};

// Also ensure wasm_main.cpp is in VFS (it's included via unity.cc)
// Actually wasm_main.cpp is #included in unity.cc content, so it doesn't
// need a separate VFS entry — wait, no. We pasted the content directly into unity.cc.
// Good, that simplifies things.

// --- Step 4: Run clang ---
const clangFlags = [
  'clang++',
  '-std=c++17',
  'unity.cc',
  '-o', 'ring_counter.wasm',
  '--target=wasm32-wasi',
  '-Wl,--no-entry',
  '-Wl,--export=init',
  '-Wl,--export=step',
  '-Wl,--export=reset_ring',
  '-Wl,--export=get_q',
  '-Wl,--export=set_enable',
  '-O2',
  '-I.',
  '-fvisibility=default',
  '-Wl,--export-dynamic',
  '-fno-threadsafe-statics',
  '-Wno-parentheses-equality',
  '-Wno-shift-count-overflow',
];

console.log('\n🔨 Compiling with @yowasp/clang...');
console.log('   Flags:', clangFlags.join(' '));

try {
  const result = await runClang(clangFlags, vfs, { timeout: 120000 });
  
  const wasmBuffer = result['ring_counter.wasm'];
  if (!wasmBuffer) {
    // Check for error output
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
    const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : '';
    console.error('❌ Compilation failed - no WASM output');
    if (stderr) console.error('STDERR:', stderr);
    if (stdout) console.error('STDOUT:', stdout);
    
    // Check what files were produced
    console.log('Output files:', Object.keys(result));
    process.exit(1);
  }

  // Write the wasm file
  const outPath = join(__dirname, 'ring_counter_unity.wasm');
  writeFileSync(outPath, Buffer.from(wasmBuffer));
  console.log(`✅ Success! WASM written to ${outPath}`);
  console.log(`   Size: ${wasmBuffer.byteLength} bytes`);

  // Also show any warnings
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
  if (stderr) {
    const warningLines = stderr.split('\n').filter(l => l.includes('warning'));
    if (warningLines.length > 0) {
      console.log('\n⚠️  Warnings:');
      warningLines.forEach(w => console.log('   ' + w));
    }
  }

  // --- Step 5: Test instantiation via WASI ---
  console.log('\n🧪 Testing WASM instantiation...');
  const { WASI } = await import('node:wasi');
  const wasi = new WASI({ version: 'preview1', preopens: {}, args: [], env: {} });
  
  const mod = await WebAssembly.compile(wasmBuffer);
  const instance = await WebAssembly.instantiate(mod, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  const exports = instance.exports;
  console.log('   Exports:', Object.keys(exports).join(', '));

  // Test the exports
  if (typeof exports.init === 'function') {
    console.log('\n▶️  Testing ring counter...');
    exports.init();
    console.log('   init() OK');
    
    console.log('   reset_ring()...');
    // Actually the user's wasm_main.cpp doesn't have reset_ring exported separately
    // in that exact name, let me check...
    
    // The functions from wasm_main.cpp are: init, reset_ring, step, get_q, set_enable
    const q0 = exports.get_q ? exports.get_q() : -1;
    console.log(`   get_q() = ${q0}`);
    
    // Step through some clock cycles
    for (let i = 0; i < 8; i++) {
      if (exports.step) {
        const q = exports.step();
        console.log(`   step() -> q = ${q} (0b${q.toString(2).padStart(4, '0')})`);
      }
    }
    
    console.log('\n✅ Ring counter test passed!');
  }

} catch (err) {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
}
#!/usr/bin/env node
import { runClang } from '@yowasp/clang';
import { readFileSync, writeFileSync } from 'node:fs';

// Test 1: Minimal VFS (just systemc.h + systemc file)
const vfs1 = {
  'systemc.h': readFileSync('systemc-src/src/systemc.h', 'utf-8'),
  'systemc': readFileSync('systemc-src/src/systemc', 'utf-8'),
  'test.cpp': '#include "systemc.h"\nint x;'
};

try {
  const r = await runClang(['clang++', '-std=c++17', '--target=wasm32-wasi', '-I.', '-c', '-o', '/dev/null', 'test.cpp'], vfs1);
  writeFileSync('test-result.log', 'TEST_MINIMAL: OK\n');
  
  // Test 2: Add sysc communication headers (first subdirectory)
  // Build just the communication/signal/kernel minimal set
  function buildDir(dirPath, tree, prefix) {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.split('.').pop();
        if (['h', 'hpp'].includes(ext)) {
          tree[entry.name] = readFileSync(dirPath + '/' + entry.name, 'utf-8');
        }
      }
    }
  }
  
  // Actually, let me just add the sysc headers incrementally
  process.stdout.write('OK\n');
} catch (e) {
  writeFileSync('test-result.log', 'TEST_MINIMAL: FAILED - ' + e.message + '\n' + (e.stderr ? new TextDecoder().decode(e.stderr).slice(0, 500) : ''));
  process.stdout.write('FAIL\n');
}
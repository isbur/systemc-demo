#!/usr/bin/env node
import { runClang } from '@yowasp/clang';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'systemc-src/src';

// Build full header tree
function buildTree(dirPath) {
  const tree = {};
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      tree[entry.name] = buildTree(fullPath);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop();
      if (['h', 'hpp'].includes(ext) || entry.name === 'systemc' || entry.name === 'systemc.h') {
        tree[entry.name] = readFileSync(fullPath, 'utf-8');
      }
    }
  }
  return tree;
}

const headerTree = buildTree(SRC);
const vfs = { ...headerTree, 'test.cpp': '#include "systemc.h"\nint x;' };

writeFileSync('test-full-vfs.json', JSON.stringify({
  fileCount: Object.keys(vfs).length,
  topKeys: Object.keys(vfs).slice(0, 20)
}));

try {
  const r = await runClang(['clang++', '-std=c++17', '--target=wasm32-wasi', '-I.', '-c', '-o', '/dev/null', 'test.cpp'], vfs);
  const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : '';
  writeFileSync('test-full-result.log', stderr);
  const errors = stderr.split('\n').filter(l => l.includes('error:') || l.includes('fatal error:'));
  if (errors.length > 0) {
    console.log('FAIL: ' + errors.length + ' errors');
    errors.slice(0, 5).forEach(e => console.log('  ' + e));
  } else {
    console.log('PASS');
  }
} catch (e) {
  writeFileSync('test-full-error.log', e.message + '\n' + (e.stderr ? new TextDecoder().decode(e.stderr).slice(0, 2000) : ''));
  console.log('EXCEPTION: ' + e.message.slice(0, 200));
}
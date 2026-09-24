#!/usr/bin/env node
import { runClang } from '@yowasp/clang';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'systemc-src/src';

// Strategy: Put everything in a subdirectory "vendor" instead of root,
// to avoid potential VFS conflicts with built-in paths
function buildTree(dirPath) {
  const tree = {};
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      tree[entry.name] = buildTree(fullPath);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop();
      if (['cpp', 'h', 'hpp'].includes(ext) || entry.name === 'systemc' || entry.name === 'systemc.h') {
        tree[entry.name] = readFileSync(fullPath, 'utf-8');
      }
    }
  }
  return tree;
}

console.log('Building VFS tree...');
const srcTree = buildTree(SRC);

// Test approach: put everything in a "vendor" subdirectory
const vfs = {
  'vendor': srcTree,
  'test.cpp': '#include "vendor/systemc.h"\nint x;'
};

console.log('VFS ready. Top keys:', Object.keys(vfs).join(', '));
console.log('vendor keys:', Object.keys(vfs.vendor).slice(0, 10).join(', '));

try {
  const r = await runClang(
    ['clang++', '-std=c++17', '--target=wasm32-wasi', '-I.', '-c', '-o', '/dev/null', 'test.cpp'],
    vfs
  );
  const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : '';
  const errors = stderr.split('\n').filter(l => l.includes('error:') || l.includes('fatal error:'));
  if (errors.length > 0) {
    console.log('FAIL:', errors.length, 'errors');
    errors.slice(0, 5).forEach(e => console.log('  ', e));
  } else {
    console.log('PASS');
    const warns = stderr.split('\n').filter(l => l.includes('warning:'));
    if (warns.length > 0) console.log('Warnings:', warns.length);
  }
} catch (e) {
  console.log('EXCEPTION:', e.message.slice(0, 200));
  const detail = e.stderr ? new TextDecoder().decode(e.stderr).slice(0, 1000) : '';
  console.log('DETAIL:', detail.slice(0, 500));
}
#!/usr/bin/env node
import { runClang } from '@yowasp/clang';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

const headerTree = buildTree('systemc-src/src');
const vfs = { ...headerTree, 'test.cpp': '#include "systemc.h"\nint x;' };

try {
  const r = await runClang(['clang++', '-std=c++17', '--target=wasm32-wasi', '-I.', '-c', '-o', '/dev/null', 'test.cpp'], vfs);
  const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : '';
  const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : '';
  writeFileSync('test-header.log', 'STDERR:\n' + stderr + '\nSTDOUT:\n' + stdout);
  console.log('COMPILE_OK');
} catch (e) {
  // The error from runClang might be thrown
  writeFileSync('test-header.log', 'EXCEPTION: ' + e.message + '\n' + (e.stderr ? new TextDecoder().decode(e.stderr) : '') + '\n' + (e.stdout ? new TextDecoder().decode(e.stdout) : ''));
  console.log('COMPILE_FAILED');
}
#!/usr/bin/env node
/**
 * build-artifacts.mjs — Генерация артефактов для браузерной компиляции SystemC.
 *
 * Создаёт:
 *   app/systemc-vfs.json    — дерево заголовков SystemC для VFS @yowasp/clang
 *   app/systemc-unity.o     — предсобранный объектный файл всех .cpp SystemC
 *
 * Запуск:  node build-artifacts.mjs
 * Требует: @yowasp/clang (установлен в node_modules)
 */

import { runClang } from '@yowasp/clang';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEMC_SRC = join(__dirname, 'app', 'systemc-src');
const OUT_DIR = join(__dirname, 'app');

// ─── 1. Сканирование дерева исходников ─────────────────────────────

/**
 * Построить вложенный объект VFS из директории.
 * Возвращает { tree, cppFiles, headerFiles }.
 */
function scanTree(dirPath, relativePath = '') {
  const tree = {};
  const cppFiles = [];
  const headerFiles = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const sub = scanTree(fullPath, relPath);
      tree[entry.name] = sub.tree;
      cppFiles.push(...sub.cppFiles);
      headerFiles.push(...sub.headerFiles);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop();
      const isHeader = ['h', 'hpp'].includes(ext)
        || entry.name === 'systemc'
        || entry.name === 'systemc.h'
        || entry.name === 'tlm'
        || entry.name === 'tlm.h';
      const isCpp = ext === 'cpp';

      if (isHeader || isCpp) {
        tree[entry.name] = readFileSync(fullPath, 'utf-8');
        if (isCpp) cppFiles.push(relPath);
        if (isHeader) headerFiles.push(relPath);
      }
    }
  }

  return { tree, cppFiles, headerFiles };
}

console.log('📂 Сканирование app/systemc-src...');
const { tree: srcTree, cppFiles, headerFiles } = scanTree(SYSTEMC_SRC, '');

// ─── 1a. Добавляем WASM-заглушки для корутин в VFS ────────────────

srcTree.sysc.kernel['sc_cor_wasm.h'] = `// WASM coroutine stub — no-op для SC_METHOD
#ifndef SC_COR_WASM_H
#define SC_COR_WASM_H

#include "sysc/kernel/sc_cor.h"

namespace sc_core {

class sc_cor_wasm : public sc_cor {};

class sc_cor_pkg_wasm : public sc_cor_pkg {
public:
    sc_cor_pkg_wasm(sc_simcontext* simc) : sc_cor_pkg(simc) {}
    virtual sc_cor* create(std::size_t, sc_cor_fn*, void*) override { return nullptr; }
    virtual void yield(sc_cor*) override {}
    virtual void abort(sc_cor*) override {}
    virtual sc_cor* get_main() override { return &m_main; }
private:
    sc_cor_wasm m_main;
};

typedef sc_cor_pkg_wasm sc_cor_pkg_t;

}
#endif
`;

srcTree.sysc.kernel['sc_cor_wasm.cpp'] = `// WASM coroutine stub — все методы пустые
#include "sysc/kernel/sc_cor_wasm.h"
`;

// ─── 1b. Патчим sc_simcontext.cpp: заменяем coroutine-инклюды на наш ──

const SIMCONTEXT_CPP = 'sc_simcontext.cpp';
if (typeof srcTree.sysc.kernel[SIMCONTEXT_CPP] === 'string') {
  let sim = srcTree.sysc.kernel[SIMCONTEXT_CPP];
  // Заменяем все #include sc_cor_* на #include sc_cor_wasm.h
  sim = sim.replace(
    /#include "sysc\/kernel\/sc_cor_\w+\.h"\s*\n/g,
    ''
  );
  sim = sim.replace(
    '#include "sysc/kernel/sc_event.h"',
    '#include "sysc/kernel/sc_cor_wasm.h"\n#include "sysc/kernel/sc_event.h"'
  );
  srcTree.sysc.kernel[SIMCONTEXT_CPP] = sim;
  console.log('   patched sc_simcontext.cpp — replaced coroutine headers with sc_cor_wasm.h');
}

// Patch sc_utils_ids.cpp: add #undef before re-includes to bypass include guards
const UTILS_ID_KEY = 'sc_utils_ids.cpp';
const UTILS_ID_PATH = 'sysc/utils/sc_utils_ids.cpp';

if (typeof srcTree.sysc?.utils?.[UTILS_ID_KEY] === 'string') {
  let patched = srcTree.sysc.utils[UTILS_ID_KEY];
  // After #include "sysc/utils/sc_report.h" (line 33), add #undef for all ID headers
  patched = patched.replace(
    '#include "sysc/utils/sc_report.h"',
    '#include "sysc/utils/sc_report.h"\n#undef SC_UTILS_IDS_H\n#undef SC_KERNEL_IDS_H\n#undef SC_COMMUNICATION_IDS_H\n#undef SC_BIT_IDS_H\n#undef SC_FX_IDS_H\n#undef SC_INT_IDS_H\n#undef SC_TRACING_IDS_H'
  );
  srcTree.sysc.utils[UTILS_ID_KEY] = patched;
  console.log('   patched sc_utils_ids.cpp — added #undef guards before re-includes');
}

console.log(`   Найдено: ${headerFiles.length} заголовков, ${cppFiles.length} .cpp файлов`);

// ─── 2. Генерация systemc-vfs.json ────────────────────────────────

console.log('\n📦 Генерация app/systemc-vfs.json...');
const vfsJsonPath = join(OUT_DIR, 'systemc-vfs.json');

// В VFS json кладём только заголовки (без .cpp — они не нужны для компиляции user-кода)
function headersOnlyTree(tree) {
  const result = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') {
      // Оставляем только заголовочные файлы
      const ext = key.split('.').pop();
      if (['h', 'hpp'].includes(ext) || key === 'systemc' || key === 'systemc.h' || key === 'tlm' || key === 'tlm.h') {
        result[key] = value;
      }
    } else {
      // Рекурсивно обходим поддиректории
      const sub = headersOnlyTree(value);
      if (Object.keys(sub).length > 0) {
        result[key] = sub;
      }
    }
  }
  return result;
}

const vfsHeaders = headersOnlyTree(srcTree);
writeFileSync(vfsJsonPath, JSON.stringify(vfsHeaders));
console.log(`   ✅ ${vfsJsonPath} (${(Buffer.byteLength(JSON.stringify(vfsHeaders)) / 1024 / 1024).toFixed(1)} MB)`);

// ─── 3. Компиляция sc_utils_ids.cpp отдельно (для SC_ID_* символов) ──

console.log('\n🔧 Компиляция sc_utils_ids.o (SC_ID_* definitions)...');
const idsVfs = {
  'ids.cc': '#include "sysc/utils/sc_utils_ids.cpp"\n',
  ...srcTree,
};

const idsResult = await runClang([
  'clang++', '-std=c++17', '-c', 'ids.cc', '-o', 'sc_ids.o',
  '--target=wasm32-wasip1', '-I.', '-O2',
  '-fvisibility=default', '-fno-threadsafe-statics',
], idsVfs, { timeout: 120000 });

const idsBuf = idsResult['sc_ids.o'];
if (!idsBuf) {
  const stderr = idsResult.stderr ? new TextDecoder().decode(idsResult.stderr) : '';
  console.error('❌ sc_ids.o compilation failed:', stderr.substring(0, 500));
  process.exit(1);
}
const idsPath = join(OUT_DIR, 'sc_ids.o');
writeFileSync(idsPath, Buffer.from(idsBuf));
console.log(`   ✅ ${idsPath} (${(idsBuf.byteLength / 1024).toFixed(0)} KB)`);

// ─── 4. Компиляция systemc-core.o (все .cpp кроме sc_utils_ids и coroutines) ──

console.log('\n🔧 Компиляция systemc-core.o...');

// Исключаем sc_utils_ids.cpp (отдельно компилируется) + настоящие корутины
// (используем свою заглушку sc_cor_wasm)
const EXCLUDE_PATTERNS = [
  'sc_utils_ids.cpp',       // отдельно
  'sc_cor_pthread.cpp',
  'sc_cor_qt.cpp',
  'sc_cor_fiber.cpp',
  'sc_cor_std_thread.cpp',
  'sc_cor_counted.cpp',
];

const coreCppFiles = cppFiles.filter(f =>
  !EXCLUDE_PATTERNS.some(p => f.endsWith(p))
);
// Явно добавляем нашу wasm-заглушку
coreCppFiles.push('sysc/kernel/sc_cor_wasm.cpp');

let coreContent = '// SystemC Core Unity — без sc_utils_ids.cpp и coroutines\n\n';
coreContent += '#include "systemc.h"\n';

coreContent += `
// --- Exception stubs (Itanium C++ ABI) ---
extern "C" {
  void* __cxa_allocate_exception(unsigned long s) { return new char[s ? s : 1]; }
  void __cxa_throw(void* obj, void*, void (*)(void*)) { (void)obj; __builtin_trap(); }
  void __cxa_rethrow() { __builtin_trap(); }
  void* __cxa_begin_catch(void* p) { return p; }
  void  __cxa_end_catch() {}
  void* __cxa_get_exception_ptr(void* p) { return p; }
}
`;

for (const cpp of coreCppFiles) {
  coreContent += `#include "${cpp}"\n`;
}

const coreVfs = { 'core.cc': coreContent, ...srcTree };
const coreResult = await runClang([
  'clang++', '-std=c++17', '-c', 'core.cc', '-o', 'systemc-core.o',
  '--target=wasm32-wasip1', '-I.', '-O2',
  '-fvisibility=default', '-fno-threadsafe-statics',
  '-Wno-parentheses-equality', '-Wno-shift-count-overflow', '-Wno-deprecated',
], coreVfs, { timeout: 120000 });

const coreBuf = coreResult['systemc-core.o'];
if (!coreBuf) {
  const stderr = coreResult.stderr ? new TextDecoder().decode(coreResult.stderr) : '';
  console.error('❌ systemc-core.o compilation failed:', stderr.substring(0, 500));
  process.exit(1);
}
const corePath = join(OUT_DIR, 'systemc-core.o');
writeFileSync(corePath, Buffer.from(coreBuf));
console.log(`   ✅ ${corePath} (${(coreBuf.byteLength / 1024 / 1024).toFixed(1)} MB)`);

console.log('\n✅ Артефакты успешно созданы!');
console.log(`   - app/systemc-vfs.json    (${(Buffer.byteLength(JSON.stringify(vfsHeaders)) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`   - app/sc_ids.o            (${(idsBuf.byteLength / 1024).toFixed(0)} KB)`);
console.log(`   - app/systemc-core.o      (${(coreBuf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
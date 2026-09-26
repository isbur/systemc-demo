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

// ─── 3. Генерация unity.cc ─────────────────────────────────────────

console.log('\n🔧 Генерация unity.cc...');

// Исключаем файлы корутин (pthread / QuickThreads — не нужны для SC_METHOD)
const EXCLUDE_PATTERNS = [
  'sc_cor_pthread.cpp',
  'sc_cor_qt.cpp',
  'sc_cor_counted.cpp',  // если есть — тоже внутреннее
];

const filteredCppFiles = cppFiles.filter(f =>
  !EXCLUDE_PATTERNS.some(p => f.endsWith(p))
);

let unityContent = '// SystemC Unity Build — auto-generated\n';
unityContent += '// Исключены: sc_cor_*.cpp (не нужны для SC_METHOD)\n\n';

// 1. systemc.h первым — определяет size_t и всё остальное
unityContent += '#include "systemc.h"\n';

// 2. Exception stubs (должны быть после systemc.h, т.к. используют size_t и т.д.)
unityContent += `
// --- Exception stubs (WASI без runtime exceptions) ---
extern "C" {
  void* __cxa_allocate_exception(unsigned long s) { return new char[s ? s : 1]; }
  void __cxa_throw(void* obj, void*, void (*)(void*)) { (void)obj; __builtin_trap(); }
  void __cxa_begin_catch(void*) {}
  void __cxa_end_catch() {}
  void* __cxa_get_exception_ptr(void* p) { return p; }
}
`;

// 3. Все .cpp файлы
for (const cpp of filteredCppFiles) {
  unityContent += `#include "${cpp}"\n`;
}

console.log(`   .cpp файлов включено: ${filteredCppFiles.length}`);
console.log(`   Исключено: ${cppFiles.length - filteredCppFiles.length}`);
console.log(`   Размер unity.cc: ~${(Buffer.byteLength(unityContent) / 1024).toFixed(0)} KB`);

// ─── 4. Компиляция в systemc-unity.o через @yowasp/clang ─────────

console.log('\n⚙ Компиляция systemc-unity.o через @yowasp/clang...');

// VFS для компиляции: unity.cc + все исходники (и .h, и .cpp)
const buildVfs = {
  'unity.cc': unityContent,
  ...srcTree,  // полное дерево со всеми файлами
};

const args = [
  'clang++',
  '-std=c++17',
  '-c',                     // только компиляция, без линковки
  'unity.cc',
  '-o', 'systemc-unity.o',
  '--target=wasm32-wasip1',
  '-I.',
  '-O2',
  '-fvisibility=default',
  '-fno-threadsafe-statics',
  '-DSC_USE_PTHREADS',      // макрос для SystemC (заглушки pthread в VFS)
  '-Wno-parentheses-equality',
  '-Wno-shift-count-overflow',
  '-Wno-deprecated',
];

console.log('   Flags:', args.join(' '));

try {
  const result = await runClang(args, buildVfs, { timeout: 120000 });

  const objBuf = result['systemc-unity.o'];

  if (!objBuf) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
    const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : '';
    console.error('❌ Компиляция не удалась');
    if (stderr) console.error('STDERR:', stderr);
    if (stdout) console.error('STDOUT:', stdout);
    process.exit(1);
  }

  const outPath = join(OUT_DIR, 'systemc-unity.o');
  writeFileSync(outPath, Buffer.from(objBuf));
  console.log(`   ✅ ${outPath} (${(objBuf.byteLength / 1024 / 1024).toFixed(1)} MB)`);

  // Показываем предупреждения
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
  if (stderr) {
    const warnings = stderr.split('\n').filter(l => l.includes('warning:'));
    if (warnings.length > 0) {
      console.log('\n⚠️  Предупреждения:');
      warnings.forEach(w => console.log('   ' + w.trim()));
    }
  }

  console.log('\n✅ Артефакты успешно созданы!');
  console.log(`   - app/systemc-vfs.json    (${(Buffer.byteLength(JSON.stringify(vfsHeaders)) / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`   - app/systemc-unity.o     (${(objBuf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  console.log('\nТеперь app/compiler.js будет использовать их в браузере.');

} catch (err) {
  console.error('\n❌ Ошибка:', err.message);
  process.exit(1);
}
#!/usr/bin/env node
/**
 * test-combined.mjs — Тест: компиляция SystemC + user code как один unity файл.
 * Если это сработает, проблема в раздельной компиляции .o + .cc.
 */
import { runClang } from '@yowasp/clang';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'app', 'systemc-src');

// --- Сканирование ---
function scanTree(dirPath, relativePath = '') {
  const tree = {};
  const cppFiles = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const sub = scanTree(fullPath, relPath);
      tree[entry.name] = sub.tree;
      cppFiles.push(...sub.cppFiles);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop();
      if (['h', 'hpp', 'cpp'].includes(ext) || entry.name === 'systemc' || entry.name === 'systemc.h' || entry.name === 'tlm' || entry.name === 'tlm.h') {
        tree[entry.name] = readFileSync(fullPath, 'utf-8');
        if (ext === 'cpp') cppFiles.push(relPath);
      }
    }
  }
  return { tree, cppFiles };
}

const { tree: srcTree, cppFiles } = scanTree(SRC, '');
const filteredCpp = cppFiles.filter(f =>
  !['sc_cor_pthread.cpp', 'sc_cor_qt.cpp', 'sc_cor_counted.cpp'].some(p => f.endsWith(p))
);

// --- Комбинированный unity.cc (SystemC + user wrapper) ---
let unity = '#include "systemc.h"\n\n';

// stubs
unity += `extern "C" {
  void* __cxa_allocate_exception(unsigned long s) { return new char[s ? s : 1]; }
  void __cxa_throw(void* obj, void*, void (*)(void*)) { (void)obj; __builtin_trap(); }
  void* __cxa_begin_catch(void* p) { return p; }
  void  __cxa_end_catch() {}
  void* __cxa_get_exception_ptr(void* p) { return p; }
}
`;

// все .cpp SystemC
for (const cpp of filteredCpp) {
  unity += `#include "${cpp}"\n`;
}

// user code + wrapper
const userCode = `
int sc_main(int, char*[]) { return 0; }
static sc_signal<bool>* clk_p;
static sc_signal<bool>* rst_p;
static sc_signal<bool>* en_p;
static sc_signal<sc_uint<4>>* q_p;
extern "C" {
void init() {
  if(clk_p) return;
  clk_p = new sc_signal<bool>("clk");
  rst_p = new sc_signal<bool>("rst");
  en_p  = new sc_signal<bool>("en");
  q_p   = new sc_signal<sc_uint<4>>("q");
  *clk_p = false; *rst_p = false; *en_p = false;
}
void reset_ring() { *rst_p = false; sc_start(SC_ZERO_TIME); *rst_p = true; sc_start(SC_ZERO_TIME); }
int32_t step() { *en_p = true; *clk_p = true; sc_start(SC_ZERO_TIME); int32_t v = q_p->read().to_int(); *clk_p = false; sc_start(SC_ZERO_TIME); return v; }
int32_t get_q() { return q_p->read().to_int(); }
void set_enable(int32_t e) { *en_p = (e != 0); }
}
`;

unity += '\n// --- User code ---\n';
unity += `SC_MODULE(user_module) {
    sc_in<bool> clk; sc_in<bool> rst_n; sc_in<bool> enable; sc_out<sc_uint<4>> q;
    sc_uint<4> shift_reg;
    void shift_proc() { if (!rst_n.read()) { shift_reg = 1; } else if (enable.read()) { bool msb = shift_reg[3]; shift_reg = shift_reg << 1; shift_reg[0] = msb; } q.write(shift_reg); }
    SC_CTOR(user_module) { SC_METHOD(shift_proc); sensitive << clk.pos(); sensitive << rst_n.neg(); }
};
`;

userCode.split('\n').forEach(l => unity += l + '\n');

const vfs = { 'unity.cc': unity, ...srcTree };

console.log('⚙ Компиляция (комбинированный unity)...');
const result = await runClang([
  'clang++', '-std=c++17', 'unity.cc', '-o', 'combined.wasm',
  '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable,--export-dynamic',
  '--target=wasm32-wasip1', '-I.',
  '-O2', '-fvisibility=default', '-fno-threadsafe-statics', '-fno-exceptions',
  '-DSC_USE_PTHREADS',
  '-Wno-parentheses-equality', '-Wno-shift-count-overflow', '-Wno-deprecated',
], vfs, { timeout: 120000 });

const wasmBuf = result['combined.wasm'];
if (wasmBuf) {
  const outPath = join(__dirname, 'combined.wasm');
  writeFileSync(outPath, Buffer.from(wasmBuf));
  console.log(`✅ ${outPath} (${(wasmBuf.byteLength / 1024).toFixed(0)} KB)`);
} else {
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
  console.error('❌', stderr || 'no output');
}
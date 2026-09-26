#!/usr/bin/env node
/**
 * test-pipeline.mjs — Сквозной тест компиляции + линковки + инстанциирования.
 * Симулирует то, что делает браузер в compiler.js.
 */
import { runClang } from '@yowasp/clang';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, 'app');

// WASI polyfill
function makeWasiPreview1(logFn) {
  const mb = { buffer: new ArrayBuffer(1) };
  const ok = () => 0;
  const ok32 = (p) => { try{ new Uint32Array(mb.buffer)[p>>2]=0; return 0; }catch{ return 0; } };
  return {
    args_get: ok,           args_sizes_get: ok,
    clock_res_get: ok,      clock_time_get: ok,
    environ_get: ok,        environ_sizes_get: ok,
    fd_advise: ok,          fd_allocate: ok,
    fd_close: ok,           fd_datasync: ok,
    fd_fdstat_get: ok32,    fd_fdstat_set_flags: ok,
    fd_filestat_get: ok,    fd_filestat_set_size: ok,
    fd_filestat_set_times: ok,
    fd_prestat_get: ok32,   fd_prestat_dir_name: ok,
    fd_pread: ok,           fd_pwrite: ok,
    fd_read: (f,i,l,n) => { try{ new Uint32Array(mb.buffer)[n>>2]=0; return 0; }catch{ return 0; } },
    fd_readdir: ok, fd_renumber: ok,
    fd_seek: (f,o,w,n) => { try{ new BigInt64Array(mb.buffer)[n>>3]=0n; return 0; }catch{ return 0; } },
    fd_sync: ok, fd_tell: ok,
    fd_write: (f,i,l,n) => {
      try {
        const u8=new Uint8Array(mb.buffer), u32=new Uint32Array(mb.buffer); let s='';
        for(let j=0;j<l;j++){ const b=u32[(i+j*8)>>2], c=u32[(i+j*8+4)>>2]; for(let k=0;k<c;k++) s+=String.fromCharCode(u8[b+k]); }
        u32[n>>2]=s.length; if(s.trim()) logFn('[wasm] '+s.trim()); return 0;
      }catch{ return 0; }
    },
    path_create_directory: ()=>-1, path_filestat_get: ()=>-1,
    path_link: ()=>-1, path_open: ()=>-1, path_readlink: ()=>-1,
    path_remove_directory: ()=>-1, path_rename: ()=>-1,
    path_symlink: ()=>-1, path_unlink_file: ()=>-1,
    poll_oneoff: ok32,
    proc_exit: (c) => logFn(`WASI exit(${c})`),
    random_get: (b,l) => { try{ crypto.getRandomValues(new Uint8Array(mb.buffer,b,l)); return 0; }catch{ return 0; } },
    sched_yield: ok,
    sock_accept: ()=>-1, sock_recv: ok, sock_send: ok, sock_shutdown: ok,
    _setMemory: (m) => { mb.buffer = m.buffer; },
  };
}

// Загружаем артефакты
console.log('📦 Загрузка артефактов...');
const coreBuf = readFileSync(join(APP, 'systemc-core.o'));
const idsBuf = readFileSync(join(APP, 'sc_ids.o'));
const headersVFS = JSON.parse(readFileSync(join(APP, 'systemc-vfs.json'), 'utf-8'));

// Пользовательский код (кольцевой регистр из Monaco)
const userCode = `#include "systemc.h"
SC_MODULE(user_module) {
    sc_in<bool>  clk; sc_in<bool>  rst_n; sc_in<bool>  enable;
    sc_out<sc_uint<4>> q; sc_uint<4> shift_reg;
    void shift_proc() {
        if (!rst_n.read()) { shift_reg = 1; }
        else if (enable.read()) { bool msb = shift_reg[3]; shift_reg = shift_reg << 1; shift_reg[0] = msb; }
        q.write(shift_reg);
    }
    SC_CTOR(user_module) { SC_METHOD(shift_proc); sensitive << clk.pos(); sensitive << rst_n.neg(); }
};
int sc_main(int, char*[]) { return 0; }
static sc_signal<bool>* clk_p; static sc_signal<bool>* rst_p;
static sc_signal<bool>* en_p;  static sc_signal<sc_uint<4>>* q_p;
static user_module* dut;
extern "C" {
void init() { if(dut)return;
  clk_p=new sc_signal<bool>("clk"); rst_p=new sc_signal<bool>("rst");
  en_p=new sc_signal<bool>("en"); q_p=new sc_signal<sc_uint<4>>("q");
  dut=new user_module("dut"); dut->clk(*clk_p); dut->rst_n(*rst_p); dut->enable(*en_p); dut->q(*q_p);
  *clk_p=false; *rst_p=false; *en_p=false;
}
void reset_ring() { *rst_p=false; sc_start(SC_ZERO_TIME); *rst_p=true; sc_start(SC_ZERO_TIME); }
int32_t step() { *en_p=true; *clk_p=true; sc_start(SC_ZERO_TIME); int32_t v=q_p->read().to_int(); *clk_p=false; sc_start(SC_ZERO_TIME); return v; }
int32_t get_q() { return q_p->read().to_int(); }
void set_enable(int32_t e) { *en_p = (e != 0); }
}`;

// VFS
const vfs = {
  'main.cc': userCode,
  'systemc-core.o': new Uint8Array(coreBuf),
  'sc_ids.o': new Uint8Array(idsBuf),
  ...headersVFS,
};

// Компиляция + линковка
const args = [
  'clang++', 'main.cc', '-std=c++17',
  'systemc-core.o', 'sc_ids.o', '-o', 'module.wasm',
  '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable,--export=__wasm_call_ctors,--export-dynamic,--initial-memory=33554432',
  '--target=wasm32-wasip1', '-I.', '-O2',
  '-fvisibility=default', '-fno-threadsafe-statics', '-fno-exceptions',
  '-Wno-parentheses-equality', '-Wno-shift-count-overflow', '-Wno-deprecated',
];

console.log('⚙ Компиляция + линковка...');
const result = await runClang(args, vfs, { timeout: 120000 });
const wasmBuf = result['module.wasm'];
if (!wasmBuf) {
  const e = result.stderr ? new TextDecoder().decode(result.stderr) : '';
  console.error('❌', e.substring(0,500));
  process.exit(1);
}
console.log(`✅ WASM: ${(wasmBuf.byteLength/1024).toFixed(0)} KB`);

// Предупреждения
const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : '';
stderr.split('\n').filter(l=>l.includes('warning:')).forEach(w=>console.log('⚠️', w.trim()));

// Инстанциирование
console.log('\n🧪 Инстанциирование...');
const wasi = makeWasiPreview1((m)=>console.log('   |', m));
const mod = await WebAssembly.compile(wasmBuf);
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
wasi._setMemory(inst.exports.memory);
const ex = inst.exports;
console.log('   Экспорты:', Object.keys(ex).join(', '));

// Конструкторы
if (ex.__wasm_call_ctors) try { ex.__wasm_call_ctors(); } catch {}

// Тест
if (typeof ex.init === 'function') {
  console.log('\n▶️  Тест кольцевого регистра...');
  ex.init(); console.log('   init() → OK');
  ex.reset_ring();
  let q = ex.get_q();
  console.log(`   reset → get_q() = ${q} (0b${q.toString(2).padStart(4,'0')})`);
  const exp = [1,2,4,8,1,2,4,8];
  let pass = true;
  for (let i=0;i<8;i++) {
    q = ex.step();
    const ok = q === exp[i];
    console.log(`   step ${i+1} → q=${q} (0b${q.toString(2).padStart(4,'0')}) ${ok?'✅':'❌'}`);
    if (!ok) pass = false;
  }
  if (pass) console.log('\n🎉 Кольцевой регистр РАБОТАЕТ!');
  else console.log('\n❌ Значения не совпадают');
}
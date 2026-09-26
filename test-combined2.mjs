#!/usr/bin/env node
// Test: compile everything as one unity (no separate .o files)
import { runClang } from '@yowasp/clang';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'app', 'systemc-src');

function scanAll(dir) {
  const t = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) t[e.name] = scanAll(fp);
    else if (e.isFile())
      t[e.name] = readFileSync(fp, 'utf-8');
  }
  return t;
}

const all = scanAll(SRC);

// Add WASM coroutine stub
all.sysc.kernel['sc_cor_wasm.h'] = `#ifndef SC_COR_WASM_H
#define SC_COR_WASM_H
#include "sysc/kernel/sc_cor.h"
namespace sc_core {
class sc_cor_wasm : public sc_cor {};
class sc_cor_pkg_wasm : public sc_cor_pkg {
public:
  sc_cor_pkg_wasm(sc_simcontext* simc) : sc_cor_pkg(simc) {}
  sc_cor* create(std::size_t, sc_cor_fn*, void*) override { return nullptr; }
  void yield(sc_cor*) override {}
  void abort(sc_cor*) override {}
  sc_cor* get_main() override { return &m_main; }
private: sc_cor_wasm m_main;
};
typedef sc_cor_pkg_wasm sc_cor_pkg_t;
}
#endif
`;

all.sysc.kernel['sc_cor_wasm.cpp'] = '#include "sysc/kernel/sc_cor_wasm.h"\n';

// Patch sc_simcontext.cpp 
let sim = all.sysc.kernel['sc_simcontext.cpp'];
sim = sim.replace(/#include "sysc\/kernel\/sc_cor_\w+\.h"\s*\n/g, '');
sim = sim.replace(
  '#include "sysc/kernel/sc_event.h"',
  '#include "sysc/kernel/sc_cor_wasm.h"\n#include "sysc/kernel/sc_event.h"'
);
all.sysc.kernel['sc_simcontext.cpp'] = sim;

// Collect all .cpp (exclude real coroutines)
const exclude = ['sc_cor_pthread.cpp','sc_cor_qt.cpp','sc_cor_fiber.cpp','sc_cor_std_thread.cpp'];
const cppFiles = [];
function collect(tree, prefix = '') {
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? prefix + '/' + k : k;
    if (typeof v === 'string') {
      if (k.endsWith('.cpp') && !exclude.some(e => k.endsWith(e)))
        cppFiles.push(p);
    } else collect(v, p);
  }
}
collect(all);

// Build unity.cc: systemc.h + stubs + all .cpp + wrapper + user code
let cc = '#include "systemc.h"\n';
cc += 'extern "C" {\n';
cc += 'void* __cxa_allocate_exception(unsigned long s){ return new char[s?s:1]; }\n';
cc += 'void __cxa_throw(void*a,void*,void(*d)(void*)){(void)a;(void)d;__builtin_trap();}\n';
cc += 'void __cxa_rethrow(){__builtin_trap();}\n';
cc += 'void* __cxa_begin_catch(void*p){return p;}\n';
cc += 'void __cxa_end_catch(){}\n';
cc += 'void* __cxa_get_exception_ptr(void*p){return p;}\n';
cc += '}\n';
for (const c of cppFiles) cc += `#include "${c}"\n`;

// User wrapper + ring counter (like Mono default)
cc += `
int sc_main(int,char*[]){return 0;}
static sc_signal<bool>* clk_p; static sc_signal<bool>* rst_p;
static sc_signal<bool>* en_p;  static sc_signal<sc_uint<4>>* q_p;
SC_MODULE(user_module) {
    sc_in<bool> clk; sc_in<bool> rst_n; sc_in<bool> enable; sc_out<sc_uint<4>> q;
    sc_uint<4> shift_reg;
    void shift_proc() {
        if (!rst_n.read()) { shift_reg = 1; }
        else if (enable.read()) { bool msb = shift_reg[3]; shift_reg = shift_reg << 1; shift_reg[0] = msb; }
        q.write(shift_reg);
    }
    SC_CTOR(user_module) { SC_METHOD(shift_proc); sensitive << clk.pos(); sensitive << rst_n.neg(); }
};
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
void set_enable(int32_t e) { *en_p = (e!=0); }
}
`;

const vfs = { 'unity.cc': cc, ...all };

console.log('Compiling combined unity...');
const result = await runClang([
  'clang++','-std=c++17','unity.cc','-o','combined.wasm',
  '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable,--export-dynamic,--initial-memory=33554432',
  '--target=wasm32-wasip1','-I.','-O2',
  '-fvisibility=default','-fno-threadsafe-statics','-fno-exceptions',
  '-Wno-parentheses-equality','-Wno-shift-count-overflow','-Wno-deprecated',
], vfs, { timeout: 120000 });

const wasmBuf = result['combined.wasm'];
if (!wasmBuf) {
  const e = result.stderr ? new TextDecoder().decode(result.stderr) : '';
  console.error('FAIL:', e.substring(0,500));
  process.exit(1);
}
const outPath = join(__dirname, 'combined.wasm');
writeFileSync(outPath, Buffer.from(wasmBuf));
console.log('✅ WASM:', (wasmBuf.byteLength/1024).toFixed(0), 'KB');

// Test instantiation (same WASI polyfill)
function makeWasi(logFn) {
  const mb = { buffer: new ArrayBuffer(1) };
  const ok = () => 0;
  const ok32 = (p) => { try { new Uint32Array(mb.buffer)[p>>2]=0; return 0; } catch { return 0; } };
  return {
    args_get: ok, args_sizes_get: ok, clock_res_get: ok, clock_time_get: ok,
    environ_get: ok, environ_sizes_get: ok,
    fd_advise: ok, fd_allocate: ok, fd_close: ok, fd_datasync: ok,
    fd_fdstat_get: ok32, fd_fdstat_set_flags: ok,
    fd_filestat_get: ok, fd_filestat_set_size: ok, fd_filestat_set_times: ok,
    fd_prestat_get: ok32, fd_prestat_dir_name: ok, fd_pread: ok, fd_pwrite: ok,
    fd_read: (f,i,l,n) => { try{ new Uint32Array(mb.buffer)[n>>2]=0; return 0; } catch { return 0; } },
    fd_readdir: ok, fd_renumber: ok,
    fd_seek: (f,o,w,n) => { try{ new BigInt64Array(mb.buffer)[n>>3]=0n; return 0; } catch { return 0; } },
    fd_sync: ok, fd_tell: ok,
    fd_write: (f,i,l,n) => { try{ const u8=new Uint8Array(mb.buffer),u32=new Uint32Array(mb.buffer);let s='';for(let j=0;j<l;j++){const b=u32[(i+j*8)>>2],c=u32[(i+j*8+4)>>2];for(let k=0;k<c;k++)s+=String.fromCharCode(u8[b+k]);}u32[n>>2]=s.length;if(s.trim())logFn(s.trim());return 0;}catch{return 0;} },
    path_create_directory: ()=>-1, path_filestat_get: ()=>-1, path_link: ()=>-1,
    path_open: ()=>-1, path_readlink: ()=>-1, path_remove_directory: ()=>-1,
    path_rename: ()=>-1, path_symlink: ()=>-1, path_unlink_file: ()=>-1,
    poll_oneoff: ok32,
    proc_exit: (c) => logFn(`exit(${c})`),
    random_get: (b,l) => { try{ crypto.getRandomValues(new Uint8Array(mb.buffer,b,l)); return 0; } catch { return 0; } },
    sched_yield: ok, sock_accept: ()=>-1, sock_recv: ok, sock_send: ok, sock_shutdown: ok,
    _setMemory: (m) => { mb.buffer = m.buffer; },
  };
}

console.log('Instantiating...');
const wasi = makeWasi((m)=>console.log('  >', m));
const mod = await WebAssembly.compile(wasmBuf);
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
wasi._setMemory(inst.exports.memory);
const ex = inst.exports;
console.log('ctors:', typeof ex.__wasm_call_ctors);
if (ex.__wasm_call_ctors) {
  try { ex.__wasm_call_ctors(); console.log('ctors OK'); } catch(e) { console.log('ctors FAIL:', e.message); }
}
console.log('init...');
try { ex.init(); console.log('init OK'); } catch(e) { console.log('init FAIL:', e.message, e.stack?.substring(0,200)); }
console.log('get_q...');
try { console.log('q =', ex.get_q()); } catch(e) { console.log('get_q FAIL:', e.message); }
console.log('step...');
try { console.log('step =', ex.step()); } catch(e) { console.log('step FAIL:', e.message); }
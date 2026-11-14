#!/usr/bin/env node
// Minimal test: compile, instantiate, call only init()
import { runClang } from '@yowasp/clang';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, 'app');

function makeWasiPreview1(logFn) {
  const mb = { buffer: new ArrayBuffer(1) };
  const ok = () => 0;
  const ok32 = (p) => { try { new Uint32Array(mb.buffer)[p>>2]=0; return 0; } catch { return 0; } };
  return {
    args_get: ok, args_sizes_get: ok, clock_res_get: ok, clock_time_get: ok,
    environ_get: ok, environ_sizes_get: ok,
    fd_advise: ok, fd_allocate: ok, fd_close: ok, fd_datasync: ok,
    fd_fdstat_get: ok32, fd_fdstat_set_flags: ok,
    fd_filestat_get: ok, fd_filestat_set_size: ok, fd_filestat_set_times: ok,
    fd_prestat_get: ok32, fd_prestat_dir_name: ok,
    fd_pread: ok, fd_pwrite: ok,
    fd_read: (f,i,l,n) => { try{ new Uint32Array(mb.buffer)[n>>2]=0; return 0; } catch{ return 0; } },
    fd_readdir: ok, fd_renumber: ok,
    fd_seek: (f,o,w,n) => { try{ new BigInt64Array(mb.buffer)[n>>3]=0n; return 0; } catch{ return 0; } },
    fd_sync: ok, fd_tell: ok,
    fd_write: (f,i,l,n) => {
      try {
        const u8=new Uint8Array(mb.buffer), u32=new Uint32Array(mb.buffer); let s='';
        for(let j=0;j<l;j++){ const b=u32[(i+j*8)>>2], c=u32[(i+j*8+4)>>2]; for(let k=0;k<c;k++) s+=String.fromCharCode(u8[b+k]); }
        u32[n>>2]=s.length; if(s.trim()) logFn(s.trim()); return 0;
      } catch { return 0; }
    },
    path_create_directory: ()=>-1, path_filestat_get: ()=>-1,
    path_link: ()=>-1, path_open: ()=>-1, path_readlink: ()=>-1,
    path_remove_directory: ()=>-1, path_rename: ()=>-1,
    path_symlink: ()=>-1, path_unlink_file: ()=>-1,
    poll_oneoff: ok32,
    proc_exit: (c) => logFn(`exit(${c})`),
    random_get: (b,l) => { try{ crypto.getRandomValues(new Uint8Array(mb.buffer,b,l)); return 0; } catch{ return 0; } },
    sched_yield: ok, sock_accept: ()=>-1, sock_recv: ok, sock_send: ok, sock_shutdown: ok,
    _setMemory: (m) => { mb.buffer = m.buffer; },
  };
}

const coreBuf = readFileSync(join(APP, 'systemc-core.o'));
const idsBuf = readFileSync(join(APP, 'sc_ids.o'));
const headersVFS = JSON.parse(readFileSync(join(APP, 'systemc-vfs.json'), 'utf-8'));

// Just init() — no SystemC code
const userCode = `int sc_main(int,char*[]){return 0;}
extern "C" {
void init(){}
void reset_ring(){}
int step(){return 0;}
int get_q(){return 0;}
void set_enable(int e){(void)e;}
}`;

const vfs = {
  'main.cc': userCode,
  'systemc-core.o': new Uint8Array(coreBuf),
  'sc_ids.o': new Uint8Array(idsBuf),
  ...headersVFS,
};

const result = await runClang([
  'clang++','main.cc','-std=c++17',
  'systemc-core.o','sc_ids.o','-o','module.wasm',
  '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable,--export-dynamic,--initial-memory=33554432',
  '--target=wasm32-wasip1','-I.','-O2',
  '-fvisibility=default','-fno-threadsafe-statics','-fno-exceptions',
], vfs, { timeout: 120000 });

const buf = result['module.wasm'];
if (!buf) {
  const e = result.stderr ? new TextDecoder().decode(result.stderr) : '';
  console.error('COMPILE FAIL:', e.substring(0,500));
  process.exit(1);
}
console.log('WASM:', (buf.byteLength/1024).toFixed(0), 'KB');

const wasi = makeWasiPreview1((m)=>console.log('WASI:', m));
const mod = await WebAssembly.compile(buf);
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
wasi._setMemory(inst.exports.memory);
if (inst.exports.__wasm_call_ctors) inst.exports.__wasm_call_ctors();
console.log('exports:', Object.keys(inst.exports).filter(k=>!k.startsWith('_')).join(','));
console.log('init() ->', inst.exports.init());
console.log('OK: minimal init works');
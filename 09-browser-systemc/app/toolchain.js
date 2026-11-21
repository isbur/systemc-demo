/**
 * In-browser clang, WASI sysroot and SystemC headers.
 * Shared by the single-file editor and the canvas circuit builder.
 */
function asset(path) {
  return new URL(path, import.meta.url).href;
}

export const SYSTEMC_CORE_O = asset('../pthread-host/systemc-core-pthread.o');
export const SC_IDS_O = asset('../pthread-host/sc_ids-pthread.o');
export const SYSTEMC_VFS_JSON = asset('./systemc-vfs.json');
export const WASI_INCLUDE_JSON = asset('../../wasi-include.json');
const LIB_ROOT = asset('../pthread-host/wasi');
const CLANG_CDN = 'https://cdn.jsdelivr.net/npm/@yowasp/clang/+esm';

let clangPromise;
export function loadClang() {
  clangPromise ??= import(CLANG_CDN).then((mod) => mod, () => {
    throw new Error('не удалось загрузить @yowasp/clang');
  });
  return clangPromise;
}

export const LIB_FILES = {
  'libc++.a': LIB_ROOT + '/eh/libc++.a',
  'libc++abi.a': LIB_ROOT + '/eh/libc++abi.a',
  'libunwind.a': LIB_ROOT + '/eh/libunwind.a',
  'libc.a': LIB_ROOT + '/libc.a',
  'libpthread.a': LIB_ROOT + '/libpthread.a',
  'crt1.o': LIB_ROOT + '/crt1.o',
  'libclang_rt.builtins.a': asset('../pthread-host/wasi/libclang_rt.builtins.a'),
};

export async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ' → ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

let toolchainPromise;
export function loadToolchain() {
  toolchainPromise ??= (async () => {
    const entries = await Promise.all(Object.entries(LIB_FILES).map(async ([name, url]) => [name, await fetchBytes(url)]));
    return {
      libs: Object.fromEntries(entries),
      include: await (await fetch(WASI_INCLUDE_JSON)).json(),
    };
  })();
  return toolchainPromise;
}

export function wasiSysroot(include, libs, withLibs) {
  const sysroot = { include };
  if (!withLibs) return sysroot;
  sysroot.lib = {
    'wasm32-wasip1-threads': {
      'libc.a': libs['libc.a'],
      'libpthread.a': libs['libpthread.a'],
      'crt1.o': libs['crt1.o'],
      eh: {
        'libc++.a': libs['libc++.a'],
        'libc++abi.a': libs['libc++abi.a'],
        'libunwind.a': libs['libunwind.a'],
      },
    },
    'wasm32-unknown-wasip1-threads': {
      'libclang_rt.builtins.a': libs['libclang_rt.builtins.a'],
    },
  };
  return sysroot;
}

const CACHE_NAME = 'llvm-chunks-v1';
const LLVM_CHUNKS = ['llvm.core.wasm', 'llvm.core2.wasm', 'llvm.core3.wasm', 'llvm.core4.wasm'];
const LLVM_BASE = 'https://cdn.jsdelivr.net/npm/@yowasp/clang/gen/';

export async function prefetchLLVM(setProgress) {
  const cache = await caches.open(CACHE_NAME);
  const uncached = [];
  for (const chunk of LLVM_CHUNKS) {
    if (!(await cache.match(LLVM_BASE + chunk))) uncached.push(chunk);
  }
  if (uncached.length === 0) {
    if (setProgress) setProgress(100, 100, '✅ LLVM (из кэша)');
    return;
  }
  let total = 0;
  const sizes = {};
  for (const chunk of uncached) {
    try {
      const response = await fetch(LLVM_BASE + chunk, { method: 'HEAD' });
      sizes[chunk] = parseInt(response.headers.get('content-length') || '0', 10) || 25_000_000;
    } catch {
      sizes[chunk] = 25_000_000;
    }
    total += sizes[chunk];
  }
  let loaded = 0;
  for (const chunk of uncached) {
    const response = await fetch(LLVM_BASE + chunk);
    cache.put(LLVM_BASE + chunk, response.clone());
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      if (setProgress) setProgress(Math.round(loaded / total * 100), 100, `⬇ LLVM ${Math.round(loaded / total * 100)}%`);
    }
  }
  if (setProgress) setProgress(100, 100, '✅ LLVM загружен');
}

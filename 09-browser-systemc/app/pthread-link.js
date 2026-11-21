const COMMON = [
  '-std=c++17', '-O1',
  '--target=wasm32-wasip1-threads', '-pthread',
  '--sysroot=/sysroot',
  '-isystem', '/usr/include/c++/v1',
  '-DSC_USE_PTHREADS',
  '-I.',
  '-fvisibility=default',
  '-mllvm', '-wasm-enable-eh', '-mllvm', '-wasm-use-legacy-eh=false',
  '-Wno-parentheses-equality', '-Wno-shift-count-overflow',
  '-Wno-deprecated', '-Wno-macro-redefined',
];

export const CIRCUIT_EXPORTS = [
  'circuit_init', 'circuit_step', 'circuit_sample', 'circuit_sample_ptr',
  'circuit_time_ps', 'circuit_status', 'circuit_deltas',
  '__wasm_call_ctors', 'wasi_thread_start',
];

export const OBJECT_FLAG_ID = COMMON.join(' ');

export function objectClangArgs(filename, outName) {
  return ['clang++', ...COMMON, '-c', filename, '-o', outName];
}

export function circuitLinkArgs(objectNames) {
  const exports = CIRCUIT_EXPORTS.map((name) => '--export=' + name).join(',');
  return [
    'clang++', ...COMMON,
    ...objectNames,
    '-o', 'circuit.wasm',
    '-nodefaultlibs',
    '/sysroot/lib/wasm32-wasip1-threads/eh/libc++.a',
    '/sysroot/lib/wasm32-wasip1-threads/eh/libc++abi.a',
    '/sysroot/lib/wasm32-wasip1-threads/eh/libunwind.a',
    '-lc', '-lpthread',
    '/sysroot/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a',
    '-Wl,--no-entry,--import-memory,' + exports
      + ',-z,stack-size=1048576,--initial-memory=16777216,--max-memory=67108864',
  ];
}

/** Флаги линковки пользовательского модуля с pthread-ядром SystemC. */
export function editorClangArgs() {
  return [
    'clang++', '-std=c++17', '-O1',
    '--target=wasm32-wasip1-threads', '-pthread',
    '--sysroot=/sysroot',
    '-isystem', '/usr/include/c++/v1',
    '-DSC_USE_PTHREADS',
    '-I.',
    '-fvisibility=default',
    '-mllvm', '-wasm-enable-eh', '-mllvm', '-wasm-use-legacy-eh=false',
    '-Wno-parentheses-equality', '-Wno-shift-count-overflow',
    '-Wno-deprecated', '-Wno-macro-redefined',
    'main.cc', 'systemc-core.o', 'sc_ids.o',
    '-o', 'module.wasm',
    '-nodefaultlibs',
    '/sysroot/lib/wasm32-wasip1-threads/eh/libc++.a',
    '/sysroot/lib/wasm32-wasip1-threads/eh/libc++abi.a',
    '/sysroot/lib/wasm32-wasip1-threads/eh/libunwind.a',
    '-lc', '-lpthread',
    '/sysroot/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a',
    '-Wl,--no-entry,--import-memory,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable,--export=__wasm_call_ctors,--export=wasi_thread_start,-z,stack-size=1048576,--initial-memory=8388608,--max-memory=67108864',
  ];
}

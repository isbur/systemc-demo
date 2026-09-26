/**
 * WASI preview1 polyfill для браузера.
 * Минимальная реализация, достаточная для WASM, скомпилированного @yowasp/clang.
 */
export function makeWasiPreview1(logFn = () => {}) {
  let mem;
  const ok = () => 0;

  const wasi = {
    fd_close: ok,
    fd_fdstat_get: ok,
    fd_fdstat_set_flags: ok,

    fd_read: (fd, iovs, iovsLen, nreadPtr) => {
      try {
        new Uint32Array(mem.buffer)[nreadPtr >> 2] = 0;
        return 0;
      } catch { return 0; }
    },

    fd_seek: ok,
    path_open: () => -1,

    fd_write: (fd, iovs, iovsLen, nwPtr) => {
      try {
        const u8 = new Uint8Array(mem.buffer);
        const u32 = new Uint32Array(mem.buffer);
        let s = '';
        for (let i = 0; i < iovsLen; i++) {
          const b = u32[(iovs + i * 8) >> 2];
          const l = u32[(iovs + i * 8 + 4) >> 2];
          for (let j = 0; j < l; j++) s += String.fromCharCode(u8[b + j]);
        }
        u32[nwPtr >> 2] = s.length;
        if (s.trim()) logFn('[wasm] ' + s.trim());
        return 0;
      } catch { return 0; }
    },

    environ_sizes_get: ok,
    environ_get: ok,
    args_sizes_get: ok,
    args_get: ok,

    random_get: (buf, len) => {
      try {
        const u8 = new Uint8Array(mem.buffer, buf, len);
        crypto.getRandomValues(u8);
        return 0;
      } catch { return 0; }
    },

    clock_time_get: ok,

    proc_exit: (code) => {
      logFn(`WASI exit(${code})`, 'info');
    },
  };

  wasi._setMemory = (m) => { mem = m; };
  return wasi;
}
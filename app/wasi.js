/**
 * WASI preview1 polyfill для браузера (полная таблица импортов).
 * Все нереализованные функции возвращают 0 или -1 (для path_*).
 */
export function makeWasiPreview1(logFn = () => {}) {
  const mem = { buffer: new ArrayBuffer(1) };
  const ok = () => 0;
  const ok_u32 = (ptr) => {
    try { new Uint32Array(mem.buffer)[ptr >> 2] = 0; return 0; }
    catch { return 0; }
  };

  const wasi = {
    // args
    args_get: ok, args_sizes_get: ok,
    // clock
    clock_res_get: ok, clock_time_get: ok,
    // environ
    environ_get: ok, environ_sizes_get: ok,
    // fd
    fd_advise: ok,
    fd_allocate: ok,
    fd_close: ok,
    fd_datasync: ok,
    fd_fdstat_get: ok_u32,
    fd_fdstat_set_flags: ok,
    fd_filestat_get: ok,
    fd_filestat_set_size: ok,
    fd_filestat_set_times: ok,
    fd_prestat_get: ok_u32,
    fd_prestat_dir_name: ok,
    fd_pread: ok,
    fd_pwrite: ok,
    fd_read: (fd, iovs, iovsLen, nreadPtr) => {
      try { new Uint32Array(mem.buffer)[nreadPtr >> 2] = 0; return 0; }
      catch { return 0; }
    },
    fd_readdir: ok,
    fd_renumber: ok,
    fd_seek: (fd, offset, whence, newoff) => {
      try { new BigInt64Array(mem.buffer)[newoff >> 3] = 0n; return 0; }
      catch { return 0; }
    },
    fd_sync: ok,
    fd_tell: ok,
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
    // path
    path_create_directory: () => -1,
    path_filestat_get: () => -1,
    path_link: () => -1,
    path_open: () => -1,
    path_readlink: () => -1,
    path_remove_directory: () => -1,
    path_rename: () => -1,
    path_symlink: () => -1,
    path_unlink_file: () => -1,
    // poll
    poll_oneoff: ok_u32,
    // proc
    proc_exit: (code) => { logFn(`WASI exit(${code})`, 'info'); },
    // random
    random_get: (buf, len) => {
      try {
        const u8 = new Uint8Array(mem.buffer, buf, len);
        crypto.getRandomValues(u8);
        return 0;
      } catch { return 0; }
    },
    // sched
    sched_yield: ok,
    // sock
    sock_accept: () => -1,
    sock_recv: ok,
    sock_send: ok,
    sock_shutdown: ok,
  };

  wasi._setMemory = (m) => { mem.buffer = m.buffer; };
  return wasi;
}
/**
 * WASI host for a module linked with lib/wasm32-wasip1-threads.
 * thread-spawn returns a thread id synchronously. std::cout arrives through fd_write
 * and is appended to a shared log so every worker writes in program order.
 */
const ALL_RIGHTS = 0xffffffffffffffffn;

export function memoryLimits(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 8;
  const uleb = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = data[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (offset < data.length) {
    const id = data[offset++];
    const length = uleb();
    const start = offset;
    if (id === 2) {
      const count = uleb();
      for (let i = 0; i < count; i++) {
        const moduleLen = uleb();
        offset += moduleLen;
        const nameLen = uleb();
        offset += nameLen;
        const kind = data[offset++];
        if (kind === 2) {
          const flags = uleb();
          const initial = uleb();
          const maximum = flags & 1 ? uleb() : initial;
          return { initial, maximum, shared: !!(flags & 2) };
        }
        if (kind === 0) uleb();
        else if (kind === 1) { uleb(); uleb(); }
        else { offset++; offset++; }
      }
    }
    offset = start + length;
  }
  throw new Error('module does not import memory');
}

export function createLog() {
  return new SharedArrayBuffer(1 << 20);
}

const STDIN_HEADER = 16;

export function createStdin(capacity = 65536) {
  return new SharedArrayBuffer(STDIN_HEADER + capacity);
}

export function writeStdin(stdin, text) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const header = new Int32Array(stdin);
  const capacity = stdin.byteLength - STDIN_HEADER;
  const data = new Uint8Array(stdin, STDIN_HEADER);
  const write = Atomics.load(header, 0);
  const read = Atomics.load(header, 1);
  if (write + bytes.length - read > capacity) return false;
  for (let i = 0; i < bytes.length; i++) data[(write + i) % capacity] = bytes[i];
  Atomics.store(header, 0, write + bytes.length);
  Atomics.add(header, 2, 1);
  Atomics.notify(header, 2);
  return true;
}

function readStdin(stdin, memory, iovs, iovsLen, nreadPtr) {
  const header = new Int32Array(stdin);
  const capacity = stdin.byteLength - STDIN_HEADER;
  const data = new Uint8Array(stdin, STDIN_HEADER);
  let read = Atomics.load(header, 1);
  let write = Atomics.load(header, 0);
  while (write === read) {
    const seq = Atomics.load(header, 2);
    write = Atomics.load(header, 0);
    if (write !== read) break;
    Atomics.wait(header, 2, seq);
    write = Atomics.load(header, 0);
    read = Atomics.load(header, 1);
  }
  const view = new DataView(memory.buffer);
  const mem = new Uint8Array(memory.buffer);
  let copied = 0;
  let left = write - read;
  for (let i = 0; i < iovsLen && left > 0; i++) {
    const ptr = view.getUint32(iovs + i * 8, true);
    const len = view.getUint32(iovs + i * 8 + 4, true);
    const n = Math.min(len, left);
    for (let j = 0; j < n; j++) mem[ptr + j] = data[(read + copied + j) % capacity];
    copied += n;
    left -= n;
  }
  Atomics.store(header, 1, read + copied);
  view.setUint32(nreadPtr, copied, true);
  return 0;
}

function decodeShared(bytes, start, length) {
  const copy = new Uint8Array(length);
  copy.set(bytes.subarray(start, start + length));
  return new TextDecoder().decode(copy);
}

export function readLog(log) {
  const size = Math.min(new Int32Array(log)[0], log.byteLength - 4);
  if (size <= 0) return '';
  return decodeShared(new Uint8Array(log), 4, size);
}

function appendLog(log, text) {
  if (!log || !text) return;
  const bytes = new TextEncoder().encode(text);
  const start = Atomics.add(new Int32Array(log), 0, bytes.length);
  const room = log.byteLength - 4 - start;
  if (room <= 0) return;
  new Uint8Array(log).set(bytes.subarray(0, Math.min(bytes.length, room)), 4 + start);
}

function writePair(view, countPtr, sizePtr, count, size) {
  view.setUint32(countPtr, count, true);
  view.setUint32(sizePtr, size, true);
  return 0;
}

export function makeImports(memory, spawn, log, stdin = null, onWrite = null) {
  const view = () => new DataView(memory.buffer);
  const wasi = {
    args_get() { return 0; },
    args_sizes_get(countPtr, sizePtr) { return writePair(view(), countPtr, sizePtr, 0, 0); },
    environ_get() { return 0; },
    environ_sizes_get(countPtr, sizePtr) { return writePair(view(), countPtr, sizePtr, 0, 0); },
    clock_res_get(_id, ptr) {
      view().setBigUint64(ptr, 1000000n, true);
      return 0;
    },
    clock_time_get(_id, _precision, ptr) {
      view().setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
    fd_close() { return 0; },
    fd_datasync() { return 0; },
    fd_sync() { return 0; },
    fd_fdstat_get(_fd, ptr) {
      const data = view();
      data.setUint8(ptr, 2);
      data.setUint16(ptr + 2, 0, true);
      data.setBigUint64(ptr + 8, ALL_RIGHTS, true);
      data.setBigUint64(ptr + 16, ALL_RIGHTS, true);
      return 0;
    },
    fd_fdstat_set_flags() { return 0; },
    fd_fdstat_set_rights() { return 0; },
    fd_filestat_get(_fd, ptr) {
      const bytes = new Uint8Array(memory.buffer, ptr, 64);
      bytes.fill(0);
      view().setUint8(ptr + 16, 2);
      return 0;
    },
    fd_seek(_fd, _offset, _whence, ptr) {
      view().setBigUint64(ptr, 0n, true);
      return 0;
    },
    fd_tell(_fd, ptr) {
      view().setBigUint64(ptr, 0n, true);
      return 0;
    },
    fd_read(fd, iovs, iovsLen, nread) {
      if (fd === 0 && stdin) return readStdin(stdin, memory, iovs, iovsLen, nread);
      view().setUint32(nread, 0, true);
      return 0;
    },
    fd_pread(_fd, _iovs, _iovsLen, _offset, nread) {
      view().setUint32(nread, 0, true);
      return 0;
    },
    fd_write(_fd, iovs, iovsLen, nwritten) {
      const data = view();
      const bytes = new Uint8Array(memory.buffer);
      let total = 0;
      let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const ptr = data.getUint32(iovs + i * 8, true);
        const len = data.getUint32(iovs + i * 8 + 4, true);
        text += decodeShared(bytes, ptr, len);
        total += len;
      }
      data.setUint32(nwritten, total, true);
      appendLog(log, text);
      if (onWrite && text) onWrite(text);
      return 0;
    },
    fd_pwrite(_fd, iovs, iovsLen, _offset, nwritten) {
      return wasi.fd_write(_fd, iovs, iovsLen, nwritten);
    },
    fd_prestat_get() { return 8; },
    fd_prestat_dir_name() { return 8; },
    fd_advise() { return 0; },
    fd_allocate() { return 0; },
    fd_filestat_set_size() { return 0; },
    fd_filestat_set_times() { return 0; },
    fd_readdir(_fd, _buf, _len, _cookie, used) {
      view().setUint32(used, 0, true);
      return 0;
    },
    fd_renumber() { return 0; },
    path_create_directory() { return 52; },
    path_filestat_get() { return 52; },
    path_filestat_set_times() { return 52; },
    path_link() { return 52; },
    path_open() { return 52; },
    path_readlink() { return 52; },
    path_remove_directory() { return 52; },
    path_rename() { return 52; },
    path_symlink() { return 52; },
    path_unlink_file() { return 52; },
    poll_oneoff(_in, _out, _nsubs, nevents) {
      view().setUint32(nevents, 0, true);
      return 0;
    },
    proc_exit(code) {
      const error = new Error('proc_exit ' + code);
      error.exitCode = code;
      throw error;
    },
    sched_yield() { return 0; },
    random_get(ptr, len) {
      const bytes = new Uint8Array(memory.buffer, ptr, len);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 31) & 255;
      return 0;
    },
    sock_accept() { return 52; },
    sock_recv() { return 52; },
    sock_send() { return 52; },
    sock_shutdown() { return 52; },
  };
  return {
    env: { memory },
    wasi_snapshot_preview1: wasi,
    wasi: {
      'thread-spawn'(startArg) {
        return spawn(startArg);
      },
    },
  };
}

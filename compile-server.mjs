#!/usr/bin/env node
/**
 * SystemC Compile Microservice v2
 * Использует @yowasp/clang (LLVM/Clang 22.0.0 в WASM) для компиляции.
 * Запуск: node compile-server.mjs [port]
 *
 * POST /compile  { code, name } → { ok, js (single-file), size, moduleName }
 * GET  /        → healthcheck
 */

import { createServer } from 'node:http';
import { runClang } from '@yowasp/clang';
import { WASI } from 'node:wasi';

const PORT = parseInt(process.argv[2] || '3082');
const TIMEOUT_MS = 60000;
const MAX_CODE_SIZE = 200_000;

/**
 * Обёртка: если код содержит SC_MODULE => добавляем пустой sc_main и экспорты.
 * Если содержит extern "C" + user_evaluate => компилируем как есть.
 */
function wrapModuleCode(code) {
  if (code.includes('SC_MODULE')) {
    return `
#include <systemc.h>
${code}
int sc_main(int, char*[]) { return 0; }
sc_signal<bool> clk_sig, rst_n_sig, enable_sig;
sc_signal<sc_uint<4>> q_sig;
#include <cstdint>
void init() {
    ${code.includes('user_module') ? 'user_module dut("dut");' : '/* unknown module name */'}
}
`;
  }
  return code;
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'systemc-compile-v2', clang: '22.0.0' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/compile') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const body = JSON.parse(buf.toString('utf-8'));
        const source = (body.code || '').trim();
        const moduleName = (body.name || 'module').replace(/[^a-zA-Z0-9_]/g, '_');

        if (!source) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Empty code' })); return; }
        if (source.length > MAX_CODE_SIZE) { res.writeHead(413); res.end(JSON.stringify({ ok: false, error: 'Code too large' })); return; }

        // Компилируем через @yowasp/clang
        const hasSC = source.includes('<systemc.h');
        const clangFlags = hasSC
          ? ['clang++', '-std=c++17', `${moduleName}.cc`, '-o', `${moduleName}.wasm`, '--target=wasm32-wasi', '-Wl,--no-entry,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable', '-O2']
          : ['clang++', '-std=c++17', `${moduleName}.cc`, '-o', `${moduleName}.wasm`, '-Wl,--no-entry,--export-dynamic', '-O2'];

        const inputFiles = { [`${moduleName}.cc`]: wrapModuleCode(source) };

        // runClang возвращает { [filename]: ArrayBuffer }
        const result = await runClang(clangFlags, inputFiles, { timeout: TIMEOUT_MS });
        const wasmBuffer = result[`${moduleName}.wasm`];
        if (!wasmBuffer) throw new Error('WASM not generated (flags may be wrong)');

        // Для теста: инстанцируем и проверяем через WASI
        const wasi = new WASI({ version: 'preview1', preopens: {} });
        const mod = await WebAssembly.compile(wasmBuffer);
        const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
        // TODO: проверить экспорты

        // Возвращаем base64 былый (браузер сам загрузит)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          moduleName,
          wasm: wasmBuffer.toString('base64'),
          size: wasmBuffer.length,
        }));
      } catch (err) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`📡 SystemC compile server v2 (@yowasp/clang 22.0.0)`);
  console.log(`   http://0.0.0.0:${PORT}`);
});
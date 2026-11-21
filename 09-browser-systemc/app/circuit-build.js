/**
 * Incremental build of one canvas circuit.
 * Each module object is cached by a hash of its source. A topology change
 * recompiles top.cc only, then relinks. The linked wasm is cached the same way.
 */
import { CELL_UNITS, circuitFingerprint, generateCircuit, modelFromEngine } from './netlist.js';
import { createObjectCache, sha256Hex } from './obj-cache.js';
import { createSimSession } from './sim-host.js';
import { circuitLinkArgs, objectClangArgs, OBJECT_FLAG_ID } from './pthread-link.js';
import {
  fetchBytes,
  loadClang,
  loadToolchain,
  prefetchLLVM,
  SC_IDS_O,
  SYSTEMC_CORE_O,
  SYSTEMC_VFS_JSON,
  wasiSysroot,
} from './toolchain.js';

const COMPILE_SALT = 'circuit-obj-v4\n' + OBJECT_FLAG_ID;
const LINK_SALT = 'circuit-link-v4\n' + circuitLinkArgs(['unit.o']).join(' ');

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function pickOutput(result, name) {
  if (!result) return null;
  if (result[name]) return toBytes(result[name]);
  const hit = Object.keys(result).find((key) => key === name || key.endsWith('/' + name));
  return hit ? toBytes(result[hit]) : null;
}

function clangErrors(log, fallback) {
  const errors = String(log || '').split('\n').filter((line) => /error:|fatal error:/.test(line)).slice(0, 30);
  return new Error(errors.join('\n') || String(log || '').slice(-2000) || fallback);
}

async function runOne(runClang, args, vfs) {
  let clangLog = '';
  let result;
  try {
    result = await runClang(args, vfs, {
      stderr: (bytes) => { if (bytes) clangLog += new TextDecoder().decode(bytes); },
    });
  } catch (error) {
    throw clangErrors(clangLog, error.message);
  }
  return { result, clangLog };
}

function compileVfs(env, filename, source, includes) {
  const vfs = {
    ...env.headers,
    sysroot: wasiSysroot(env.include, env.libs, false),
    [filename]: source,
  };
  for (const name of includes) {
    const text = env.sources[name];
    if (text == null) throw new Error('нет исходника ' + name);
    vfs[name] = text;
  }
  return vfs;
}

async function hashUnit(unit, env) {
  let material = COMPILE_SALT + '\n' + unit.filename + '\n' + unit.source;
  for (const name of unit.includes || []) {
    const text = env.sources[name];
    if (text == null) throw new Error('нет исходника ' + name);
    material += '\n// ' + name + '\n' + text;
  }
  return sha256Hex(material);
}

function runtimeUnit(env) {
  const source = env.sources['circuit-rt.cpp'];
  if (!source) throw new Error('нет circuit-rt.cpp');
  return { id: 'runtime', filename: 'circuit_rt.cc', role: 'runtime', includes: [], source };
}

export async function compileCircuit(gen, env, cache) {
  const started = now();
  const planned = [runtimeUnit(env), ...gen.units];
  const stats = { units: [], link: { result: 'miss', ms: 0 }, totalMs: 0, cold: false };
  const objects = [];
  for (const unit of planned) {
    const key = await hashUnit(unit, env);
    const outName = unit.filename.replace(/\.cc$/, '.o');
    const cached = await cache.get('obj:' + key);
    if (cached) {
      stats.units.push({ id: unit.id, result: 'hit', ms: 0, key });
      objects.push({ id: unit.id, name: outName, bytes: cached, key });
      continue;
    }
    const t0 = now();
    const { result, clangLog } = await runOne(
      env.runClang,
      objectClangArgs(unit.filename, outName),
      compileVfs(env, unit.filename, unit.source, unit.includes || []),
    );
    const bytes = pickOutput(result, outName);
    if (!bytes) throw clangErrors(clangLog, 'нет ' + outName);
    await cache.set('obj:' + key, bytes);
    stats.units.push({ id: unit.id, result: 'miss', ms: now() - t0, key });
    objects.push({ id: unit.id, name: outName, bytes, key });
  }

  const linkKey = await sha256Hex(LINK_SALT + '\n' + objects.map((obj) => obj.key).join('\n'));
  let wasm = await cache.get('wasm:' + linkKey);
  if (wasm) {
    stats.link = { result: 'hit', ms: 0 };
  } else {
    const t0 = now();
    const names = [...objects.map((obj) => obj.name), 'systemc-core.o', 'sc_ids.o'];
    const vfs = {
      sysroot: wasiSysroot(env.include, env.libs, true),
      'systemc-core.o': env.core,
      'sc_ids.o': env.ids,
    };
    for (const obj of objects) vfs[obj.name] = obj.bytes;
    const { result, clangLog } = await runOne(env.runClang, circuitLinkArgs(names), vfs);
    wasm = pickOutput(result, 'circuit.wasm');
    if (!wasm) throw clangErrors(clangLog, 'нет circuit.wasm');
    await cache.set('wasm:' + linkKey, wasm);
    stats.link = { result: 'miss', ms: now() - t0 };
  }
  stats.totalMs = now() - started;
  stats.cold = stats.units.every((unit) => unit.result === 'miss') && stats.link.result === 'miss';
  return { wasm, wasmKey: linkKey, stats };
}

export function formatBuildStats(stats) {
  const misses = stats.units.filter((unit) => unit.result === 'miss');
  const hits = stats.units.length - misses.length;
  const compileMs = Math.round(misses.reduce((sum, unit) => sum + unit.ms, 0));
  const linkMs = Math.round(stats.link.ms);
  if (!misses.length && stats.link.result === 'hit') {
    return `сборка из кэша: ${hits} модулей без перекомпиляции`;
  }
  const kind = hits === 0 ? 'полная сборка' : 'инкрементальная сборка';
  const names = misses.map((unit) => `${unit.id} ${Math.round(unit.ms)} мс`).join(', ');
  return `${kind}: ${names}; из кэша ${hits}; линковка ${linkMs} мс (компиляция ${compileMs} мс)`;
}

const CELL_FILES = [...new Set(Object.values(CELL_UNITS).map((cell) => cell.file))];

async function loadSources() {
  const names = [...CELL_FILES, 'circuit-rt.cpp'];
  const entries = await Promise.all(names.map(async (name) => {
    const url = new URL(name === 'circuit-rt.cpp' ? './circuit-rt.cpp' : './cells/' + name, import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(name + ' → ' + response.status);
    return [name, await response.text()];
  }));
  return Object.fromEntries(entries);
}

let envPromise;
export function loadBrowserEnv(setProgress) {
  envPromise ??= (async () => {
    if (setProgress) setProgress(0, 100, 'LLVM…');
    await prefetchLLVM(setProgress);
    const [clangMod, headers, toolchain, core, ids, sources] = await Promise.all([
      loadClang(),
      fetch(SYSTEMC_VFS_JSON).then((response) => {
        if (!response.ok) throw new Error('systemc-vfs.json → ' + response.status);
        return response.json();
      }),
      loadToolchain(),
      fetchBytes(SYSTEMC_CORE_O),
      fetchBytes(SC_IDS_O),
      loadSources(),
    ]);
    return {
      runClang: clangMod.runClang,
      headers,
      include: toolchain.include,
      libs: toolchain.libs,
      core,
      ids,
      sources,
    };
  })();
  return envPromise;
}

function applySample(engine, manifest, sample) {
  for (const el of engine.elements) {
    const pins = manifest.byPin[String(el.uid)];
    el._inCircuit = !!pins;
    if (!pins) continue;
    for (const pin of el.outputPins) {
      const id = pins[pin];
      if (id != null) el.outputs[pin] = sample.values[id] ? 1 : 0;
    }
    for (const pin of el.inputPins) {
      const id = pins[pin];
      if (id != null) el.inputs[pin] = sample.values[id] ? 1 : 0;
    }
  }
  engine.time = sample.timeNs;
}

function statusText(status) {
  if (status === 1) return 'Дельта-циклы не сошлись — комбинационная петля. SystemC остановил модель.';
  return 'SystemC остановил модель (код ' + status + ')';
}

export function createCircuitHost(deps) {
  const cache = deps.cache || createObjectCache();
  let env = null;
  let session = null;
  let manifest = null;
  let fingerprint = null;
  let wasmKey = null;
  const log = deps.log || (() => {});

  async function environment() {
    if (!env) env = deps.loadEnv ? await deps.loadEnv() : await loadBrowserEnv(deps.setProgress);
    return env;
  }

  function plan(engine) {
    const model = modelFromEngine(engine);
    const fp = circuitFingerprint(model);
    const gen = generateCircuit(model);
    if (gen.error) throw new Error(gen.error);
    return { fp, gen };
  }

  function dropSession() {
    if (session && deps.sessions) {
      const index = deps.sessions.indexOf(session);
      if (index >= 0) deps.sessions.splice(index, 1);
    }
    session?.dispose();
    session = null;
  }

  async function boot(engine, fp, gen) {
    deps.setStatus?.('Сборка схемы…');
    const built = await compileCircuit(gen, await environment(), cache);
    log(formatBuildStats(built.stats), built.stats.cold ? 'info' : 'ok');
    if (!session || wasmKey !== built.wasmKey) {
      dropSession();
      session = createSimSession(
        (text) => log(text, 'wasm'),
        (text) => log(text, 'err'),
      );
      deps.sessions?.push(session);
      await session.load(built.wasm);
      wasmKey = built.wasmKey;
      const initStatus = await session.call('circuit_init');
      if (initStatus) log(statusText(initStatus), 'err');
    }
    manifest = gen.manifest;
    fingerprint = fp;
    const sample = await session.sample();
    applySample(engine, manifest, sample);
    sample.stats = built.stats;
    deps.setStatus?.('Схема собрана');
    return sample;
  }

  async function ensure(engine) {
    const { fp, gen } = plan(engine);
    if (session && fingerprint === fp && manifest) return null;
    return boot(engine, fp, gen);
  }

  return {
    async sync(engine) {
      const sample = await ensure(engine);
      if (sample) return sample;
      const current = await session.sample();
      applySample(engine, manifest, current);
      return current;
    },
    async step(engine) {
      await ensure(engine);
      const status = await session.call('circuit_step');
      const sample = await session.sample();
      sample.status = status || sample.status;
      applySample(engine, manifest, sample);
      return sample;
    },
    async reset(engine) {
      dropSession();
      fingerprint = null;
      const { fp, gen } = plan(engine);
      return boot(engine, fp, gen);
    },
  };
}

/**
 * Сохранение / восстановление схемы в localStorage,
 * включая скомпилированные WASM-модули.
 */
import { GATES } from './elements.js';
import { attachWasmElement, restoreWasmSession } from './compiler.js';

const STORAGE_KEY = 'systemc-constructor-v3';
const WASM_DB = 'systemc-constructor';
const WASM_STORE = 'wasm';

const WASM_GATE = {
  label: 'SysC',
  inputPins: ['clk', 'rst_n', 'enable'],
  outputPins: ['q0', 'q1', 'q2', 'q3'],
  color: '#673AB7',
};

function openWasmDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WASM_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WASM_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeWasm(uid, bytes) {
  const db = await openWasmDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(WASM_STORE, 'readwrite');
    tx.objectStore(WASM_STORE).put(bytes, String(uid));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readWasm(uid) {
  const db = await openWasmDb();
  const bytes = await new Promise((resolve, reject) => {
    const tx = db.transaction(WASM_STORE, 'readonly');
    const request = tx.objectStore(WASM_STORE).get(String(uid));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return bytes ? new Uint8Array(bytes) : null;
}

async function dropStaleWasm(liveUids) {
  const db = await openWasmDb();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction(WASM_STORE, 'readonly');
    const request = tx.objectStore(WASM_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(WASM_STORE, 'readwrite');
    for (const key of keys) {
      if (!liveUids.has(String(key))) tx.objectStore(WASM_STORE).delete(key);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function loadSource() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return typeof data?.source === 'string' ? data.source : null;
  } catch {
    return null;
  }
}

/**
 * Сохранить текущее состояние визуальной схемы, соединений и WASM-бинарников.
 * source — текст своего модуля. Если его нет (редактор ещё не готов),
 * остаётся предыдущая копия.
 */
export async function saveState(viz, sim, source) {
  if (!viz) return;
  const data = {
    viz: viz.serialize(),
    connections: sim.serializeConnections(),
  };
  if (typeof source === 'string') data.source = source;
  else {
    const previous = loadSource();
    if (previous !== null) data.source = previous;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('saveState error:', e.message);
  }

  const live = new Set();
  for (const [uid, view] of viz.elementViews) {
    if (!view.el._wasmBinary) continue;
    live.add(String(uid));
    try {
      await writeWasm(uid, new Uint8Array(view.el._wasmBinary));
    } catch (e) {
      console.warn('save wasm error:', e.message);
    }
  }
  try {
    await dropStaleWasm(live);
  } catch (e) {
    console.warn('prune wasm error:', e.message);
  }
}

/**
 * Создать throttled-версию saveState.
 */
export function scheduleSave(viz, sim, getSource, delayMs = 300) {
  let timer = null;
  const run = () => {
    timer = null;
    saveState(viz, sim, typeof getSource === 'function' ? getSource() : undefined);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };
  window.addEventListener('pagehide', () => {
    if (timer) clearTimeout(timer);
    timer = null;
    run();
  });
  return schedule;
}

/**
 * Восстановить схему из localStorage.
 * wasmRestorer — функция (uid, base64) => Promise<session>.
 *
 * Возвращает true, если данные были найдены.
 */
export async function loadState(viz, sim, log, wasmRestorer) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (!data.viz?.elements?.length) return false;

    for (const element of data.viz.elements) {
      if (GATES[element.type]) continue;
      GATES[element.type] = data.viz.gates?.[element.type] || { ...WASM_GATE };
    }

    viz.deserialize(data.viz);
    // Новый формат кладёт провода в viz.links. Старые сохранения — только в connections.
    // Оба списка одинаковые: { fromUid, fromPin, toUid, toPin }. Граф сам наполняет SimEngine.
    const wires = Array.isArray(data.viz.links)
      ? data.viz.links
      : (Array.isArray(data.connections) ? data.connections : []);
    viz.restoreWires(wires);

    if (wasmRestorer) {
      for (const element of data.viz.elements) {
        const uid = String(element.uid);
        let bytes = null;
        try {
          bytes = await readWasm(uid);
        } catch (e) {
          console.warn('read wasm error:', e.message);
        }
        if (!bytes && data.wasmModules?.[uid]) {
          bytes = Uint8Array.from(atob(data.wasmModules[uid]), (c) => c.charCodeAt(0));
        }
        if (!bytes) continue;
        try {
          const session = await wasmRestorer(uid, bytes);
          if (!session) continue;
          const view = viz.elementViews.get(uid);
          if (!view) continue;
          attachWasmElement(view.el, session);
          view.el._wasmBinary = bytes;
        } catch (e) {
          console.warn('restore wasm error:', e.message);
        }
      }
    }

    viz.updateStates();

    const count = data.viz.elements.length;
    log(`↻ Схема восстановлена (${count} элементов)`, 'ok');
    return true;
  } catch (e) {
    console.warn('loadState error:', e.message);
    return false;
  }
}
/**
 * Сохранение / восстановление схемы в localStorage,
 * включая скомпилированные WASM-модули.
 */

const STORAGE_KEY = 'systemc-constructor-v2';

/**
 * Сохранить текущее состояние визуальной схемы, соединений и WASM-бинарников.
 */
export function saveState(viz, sim) {
  if (!viz) return;
  const data = {
    viz: viz.serialize(),
    connections: sim.serializeConnections(),
    wasmModules: {},
  };

  // Собираем WASM-бинарники с элементов
  for (const [uid, view] of viz.elementViews) {
    if (view.el._wasmBinary) {
      const buf = view.el._wasmBinary;
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      data.wasmModules[uid] = base64;
    }
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('saveState error:', e.message);
  }
}

/**
 * Создать throttled-версию saveState.
 */
export function scheduleSave(viz, sim, delayMs = 300) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveState(viz, sim), delayMs);
  };
}

/**
 * Восстановить схему из localStorage.
 * wasmRestorer — функция (uid, base64) => Promise<exports>,
 * которая декодирует и инстанциирует WASM-модуль.
 *
 * Возвращает true, если данные были найдены.
 */
export async function loadState(viz, sim, log, wasmRestorer) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (!data.viz?.elements?.length) return false;

    // Восстанавливаем WASM-модули в GATES до десериализации схемы
    const uidToExports = {};
    if (wasmRestorer && data.wasmModules) {
      for (const [uid, base64] of Object.entries(data.wasmModules)) {
        try {
          uidToExports[uid] = wasmRestorer(uid, base64);
        } catch (e) {
          console.warn('restore wasm error:', e.message);
        }
      }
      // Дожидаемся всех
      await Promise.all(Object.values(uidToExports));
      // Теперь uidToExports[uid] содержит exports
      for (const [uid, promise] of Object.entries(uidToExports)) {
        uidToExports[uid] = await promise;
      }
    }

    // Десериализуем элементы (типы должны уже быть в GATES)
    viz.deserialize(data.viz);
    sim.deserializeConnections(data.connections || [], (uid) => {
      const view = viz.elementViews.get(uid);
      return view ? view.el : null;
    });

    // Подключаем WASM-экспорты к восстановленным элементам
    for (const [uid, exports] of Object.entries(uidToExports)) {
      const view = viz.elementViews.get(uid);
      if (!view) continue;
      // Переустанавливаем функции-обработчики
      view.el._evaluateFn = (inp, out) => {
        const v = exports.get_q ? exports.get_q() : 0;
        out.q0 = (v >> 0) & 1; out.q1 = (v >> 1) & 1;
        out.q2 = (v >> 2) & 1; out.q3 = (v >> 3) & 1;
      };
      view.el._clockEdgeFn = (edge, inp, out) => {
        if (edge !== 'pos') return;
        if (inp.rst_n === 0) {
          if (exports.reset_ring) exports.reset_ring();
          const v = exports.get_q ? exports.get_q() : 0;
          out.q0 = (v>>0)&1; out.q1 = (v>>1)&1; out.q2 = (v>>2)&1; out.q3 = (v>>3)&1;
          return;
        }
        if (exports.set_enable) exports.set_enable(inp.enable ?? 0);
        const v = exports.step ? exports.step() : 0;
        out.q0 = (v>>0)&1; out.q1 = (v>>1)&1; out.q2 = (v>>2)&1; out.q3 = (v>>3)&1;
      };
      view.el._resetFn = () => { if (exports.reset_ring) exports.reset_ring(); };
      view.el._wasmBinary = Uint8Array.from(atob(data.wasmModules[uid]), c => c.charCodeAt(0));
    }

    viz.updateStates();

    const count = data.viz.elements.length;
    log(`↻ Схема восстановлена (${count} элементов${data.wasmModules ? ', WASM' : ''})`, 'ok');
    return true;
  } catch (e) {
    console.warn('loadState error:', e.message);
    return false;
  }
}
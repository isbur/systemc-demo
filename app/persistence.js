/**
 * Сохранение / восстановление схемы в localStorage.
 */

const STORAGE_KEY = 'systemc-constructor-v1';

/**
 * Сохранить текущее состояние визуальной схемы и соединений.
 */
export function saveState(viz, sim) {
  if (!viz) return;
  const data = {
    viz: viz.serialize(),
    connections: sim.serializeConnections(),
  };
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
 * Возвращает true, если данные были найдены и применены.
 */
export function loadState(viz, sim, log) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (!data.viz?.elements?.length) return false;

    viz.deserialize(data.viz);
    sim.deserializeConnections(data.connections || [], (uid) => {
      const view = viz.elementViews.get(uid);
      return view ? view.el : null;
    });
    viz.updateStates();

    const count = data.viz.elements.length;
    log(`↻ Схема восстановлена из localStorage (${count} элементов)`, 'ok');
    return true;
  } catch (e) {
    console.warn('loadState error:', e.message);
    return false;
  }
}
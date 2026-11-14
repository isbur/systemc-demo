/**
 * Раскладка панелей.
 * Широкий экран — Dockview (стыки, вкладки, перетаскивание, плавающие окна).
 * Узкий или сенсорный — одна панель и нижние вкладки, без стыков:
 * жест Dockview (долгое нажатие на вкладку) не спорит со сдвигом канвы.
 */
import { createDockview, themeAbyss, version } from './vendor/dockview/dockview.js';

export { version as dockviewVersion };

const LAYOUT_KEY = 'systemc-constructor-dock-v1';
const MOBILE_TAB_KEY = 'systemc-constructor-mobile-tab';

const PANELS = [
  { id: 'scheme', title: 'Схема' },
  { id: 'code', title: 'Код' },
  { id: 'log', title: 'Лог' },
  { id: 'palette', title: 'Элементы' },
  { id: 'signals', title: 'Сигналы' },
];

const REQUIRED = PANELS.map((panel) => panel.id);

export function isCompactLayout() {
  const narrow = window.innerWidth < 768;
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return narrow || (touch && window.innerWidth < 1100);
}

export function initShell(hooks = {}) {
  const pen = document.getElementById('panel-pen');
  const dockHost = document.getElementById('dock');
  const stage = document.getElementById('mobile-stage');
  const tabs = document.getElementById('mobile-tabs');
  const resetButton = document.getElementById('btn-reset-layout');
  if (!pen || !dockHost || !stage || !tabs) {
    throw new Error('Нет контейнеров раскладки');
  }

  let api = null;
  let applying = false;
  let saveTimer = null;
  let compact = isCompactLayout();
  let mobileTab = readMobileTab();
  const nodes = Object.fromEntries(PANELS.map((panel) => {
    const element = document.getElementById(`panel-${panel.id}`);
    if (!element) throw new Error(`Нет панели ${panel.id}`);
    return [panel.id, element];
  }));

  for (const panel of PANELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.panel = panel.id;
    button.textContent = panel.title;
    button.addEventListener('click', () => showMobile(panel.id));
    tabs.appendChild(button);
  }

  function node(id) {
    const element = nodes[id];
    if (!element) throw new Error(`Нет панели ${id}`);
    return element;
  }

  function park(id) {
    const element = node(id);
    if (element.parentElement !== pen) pen.appendChild(element);
  }

  function relayout() {
    hooks.relayoutScheme?.();
    hooks.relayoutCode?.();
  }

  function watchPanel(panel) {
    if (!panel?.api || panel.__watched) return;
    panel.__watched = true;
    const refresh = () => relayout();
    panel.api.onDidDimensionsChange?.(refresh);
    panel.api.onDidVisibilityChange?.((event) => {
      if (event?.isVisible) refresh();
    });
  }

  function createComponent(options) {
    const element = node(options.name);
    const root = document.createElement('div');
    root.className = 'dock-panel';
    root.appendChild(element);
    return {
      element: root,
      init() {},
      dispose() {
        if (element.isConnected && root.contains(element)) pen.appendChild(element);
      },
    };
  }

  function buildDefault() {
    applying = true;
    try {
      api.addPanel({ id: 'scheme', component: 'scheme', title: 'Схема' });
      api.addPanel({
        id: 'palette',
        component: 'palette',
        title: 'Элементы',
        initialWidth: 176,
        position: { referencePanel: 'scheme', direction: 'left' },
      });
      api.addPanel({
        id: 'code',
        component: 'code',
        title: 'Код',
        initialWidth: 380,
        position: { referencePanel: 'scheme', direction: 'right' },
      });
      api.addPanel({
        id: 'log',
        component: 'log',
        title: 'Лог',
        initialHeight: 168,
        position: { referencePanel: 'scheme', direction: 'below' },
      });
      api.addPanel({
        id: 'signals',
        component: 'signals',
        title: 'Сигналы',
        position: { referencePanel: 'log', direction: 'within' },
      });
      api.getPanel('scheme')?.api.setActive();
      api.getPanel('log')?.api.setActive();
      api.getPanel('scheme')?.api.setActive();
    } finally {
      applying = false;
    }
  }

  function panelIds(data) {
    const ids = new Set();
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.id === 'string' && typeof value.contentComponent === 'string') {
        ids.add(value.id);
      }
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      Object.values(value).forEach(walk);
    };
    walk(data);
    return ids;
  }

  function layoutComplete() {
    return REQUIRED.every((id) => api.getPanel(id));
  }

  function applySavedOrDefault() {
    const saved = readLayout();
    if (!saved) {
      buildDefault();
      return;
    }
    const ids = panelIds(saved);
    if (!REQUIRED.every((id) => ids.has(id))) {
      console.warn('Раскладка без обязательных панелей, возврат к умолчанию');
      localStorage.removeItem(LAYOUT_KEY);
      buildDefault();
      return;
    }
    applying = true;
    try {
      api.fromJSON(saved);
      if (!layoutComplete()) throw new Error('неполная раскладка');
    } catch (error) {
      console.warn('Битая раскладка, возврат к умолчанию', error);
      localStorage.removeItem(LAYOUT_KEY);
      try {
        for (const panel of [...(api.panels || [])]) api.removePanel(panel);
      } catch { /* группы уже сняты */ }
      for (const id of REQUIRED) park(id);
      buildDefault();
    } finally {
      applying = false;
    }
  }

  function mountDesktop() {
    document.body.classList.add('mode-desktop');
    document.body.classList.remove('mode-mobile');
    for (const id of REQUIRED) park(id);
    dockHost.replaceChildren();
    api = createDockview(dockHost, {
      theme: themeAbyss,
      // Указатель, не HTML5: перетаскивание вкладки не пересекается
      // с переносом блока из палитры и с жестами канвы.
      dndStrategy: 'pointer',
      createComponent,
    });
    api.onDidAddPanel((event) => {
      const panel = event?.api ? event : event?.panel;
      watchPanel(panel);
    });
    api.onDidLayoutChange(() => {
      if (applying) return;
      scheduleSave();
      relayout();
    });
    dockHost.addEventListener('keydown', (event) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && event.target.closest?.('.dv-tab')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    applySavedOrDefault();
    requestAnimationFrame(relayout);
  }

  function unmountDesktop() {
    if (!api) return;
    applying = true;
    try {
      for (const id of REQUIRED) park(id);
      api.dispose();
    } catch (error) {
      console.warn(error);
      for (const id of REQUIRED) park(id);
    } finally {
      api = null;
      applying = false;
    }
    dockHost.replaceChildren();
  }

  function showMobile(id) {
    if (!REQUIRED.includes(id)) id = 'scheme';
    mobileTab = id;
    try { localStorage.setItem(MOBILE_TAB_KEY, id); } catch { /* приватный режим */ }
    for (const panelId of REQUIRED) {
      if (panelId !== id) park(panelId);
    }
    const element = node(id);
    if (element.parentElement !== stage) stage.appendChild(element);
    for (const button of tabs.querySelectorAll('button')) {
      const on = button.dataset.panel === id;
      button.classList.toggle('active', on);
      button.setAttribute('aria-current', on ? 'page' : 'false');
    }
    requestAnimationFrame(() => requestAnimationFrame(relayout));
  }

  function mountMobile() {
    document.body.classList.add('mode-mobile');
    document.body.classList.remove('mode-desktop');
    unmountDesktop();
    showMobile(mobileTab);
  }

  function mount() {
    compact = isCompactLayout();
    if (compact) mountMobile();
    else mountDesktop();
  }

  function scheduleSave() {
    if (compact || !api) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 200);
  }

  function flushSave() {
    saveTimer = null;
    if (compact || !api || applying) return;
    try {
      if (!layoutComplete()) return;
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
    } catch (error) {
      console.warn('Не удалось сохранить раскладку', error);
    }
  }

  function resetLayout() {
    localStorage.removeItem(LAYOUT_KEY);
    mobileTab = 'scheme';
    localStorage.removeItem(MOBILE_TAB_KEY);
    if (compact) {
      showMobile('scheme');
      return;
    }
    applying = true;
    try {
      const open = [...(api?.panels || [])];
      for (const panel of open) api.removePanel(panel);
      for (const id of REQUIRED) park(id);
      buildDefault();
    } finally {
      applying = false;
    }
    flushSave();
    requestAnimationFrame(relayout);
  }

  resetButton?.addEventListener('click', () => {
    resetLayout();
    hooks.onReset?.();
  });

  window.addEventListener('pagehide', flushSave);
  const desktopQuery = window.matchMedia('(max-width: 767px), (pointer: coarse)');
  desktopQuery.addEventListener?.('change', () => {
    const next = isCompactLayout();
    if (next === compact) {
      relayout();
      return;
    }
    flushSave();
    mount();
  });
  window.addEventListener('resize', () => {
    const next = isCompactLayout();
    if (next === compact) return;
    flushSave();
    mount();
  });

  mount();

  return { resetLayout, isCompact: () => compact, relayout };
}

function readLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.grid) return null;
    return data;
  } catch {
    return null;
  }
}

function readMobileTab() {
  try {
    const id = localStorage.getItem(MOBILE_TAB_KEY);
    return REQUIRED.includes(id) ? id : 'scheme';
  } catch {
    return 'scheme';
  }
}

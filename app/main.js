/**
 * Главный модуль приложения SystemC Constructor.
 * Оркестрирует Monaco, визуальный конструктор, симуляцию, компиляцию, сохранение.
 */
import { SimEngine, GATES } from './elements.js';
import { VisualConstructor } from './constructor.js';
import { compileCpp } from './compiler.js';
import { scheduleSave, loadState } from './persistence.js';

// ─── DOM refs ──────────────────────────────────────────────────────
const logPanel     = document.getElementById('log-panel');
const statusText   = document.getElementById('status-text');
const cycleDisplay = document.getElementById('cycle-display');
const paletteList  = document.getElementById('palette-list');
const svg          = document.getElementById('canvas-svg');

// Buttons
const btnCompile   = document.getElementById('btn-compile-cpp');
const btnStep      = document.getElementById('btn-step');
const btnReset     = document.getElementById('btn-reset');
const btnRun       = document.getElementById('btn-run');

// ─── Логирование ───────────────────────────────────────────────────
function log(msg, cls = 'line') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = `> ${msg}`;
  logPanel.appendChild(d);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function setStatus(text) {
  statusText.textContent = text;
}

// ─── Симуляция ─────────────────────────────────────────────────────
const sim = new SimEngine();
let viz = null;
let isRunning = false;

sim.on('step', ({ cycle }) => {
  cycleDisplay.textContent = `Такт: ${cycle}`;
  if (viz) viz.updateStates();
});

// ─── Monaco Editor ─────────────────────────────────────────────────
const DEFAULT_CODE = `// ─── 4-битный кольцевой регистр на SystemC ────────────────────
//  ⚠ SC_THREAD и wait() НЕ поддерживаются (WASI без pthread)!
//  Используйте только SC_METHOD / SC_CTHREAD.
//
//  Модуль ДОЛЖЕН называться user_module (так его находит обёртка).
//  Порты: clk, rst_n, enable (входы), q — sc_uint<4> (выход).

#include "systemc.h"

SC_MODULE(user_module) {
    sc_in<bool>  clk;
    sc_in<bool>  rst_n;
    sc_in<bool>  enable;
    sc_out<sc_uint<4>> q;

    sc_uint<4> shift_reg;

    void shift_proc() {
        if (!rst_n.read()) {
            shift_reg = 1;
        } else if (enable.read()) {
            bool msb = shift_reg[3];
            shift_reg = shift_reg << 1;
            shift_reg[0] = msb;
        }
        q.write(shift_reg);
    }

    SC_CTOR(user_module) {
        SC_METHOD(shift_proc);
        sensitive << clk.pos();
        sensitive << rst_n.neg();
    }
};
`;

let monacoEditor = null;

function initMonaco() {
  // Monaco AMD loader уже загружен (vs/loader.js в index.html)
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    monacoEditor = monaco.editor.create(document.getElementById('monaco-container'), {
      value: DEFAULT_CODE,
      language: 'cpp',
      theme: 'vs-dark',
      fontSize: 13,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
    setStatus('Monaco Editor готов');
    log('Monaco Editor загружен', 'info');
  });
}

// ─── Визуальный конструктор ─────────────────────────────────────────
function initVisualConstructor() {
  viz = new VisualConstructor(svg, sim);

  const saveFn = scheduleSave(viz, sim);

  viz.onEvent = (event, data) => {
    saveFn();
    if (event === 'element-placed') {
      setStatus(`➕ ${data.name}`);
      log(`Добавлен элемент: ${data.name} (${data.type})`, 'ok');
    }
  };

  sim.on('connected', () => saveFn());
}

// ─── Палитра элементов ──────────────────────────────────────────────
function buildPalette() {
  for (const [type, config] of Object.entries(GATES)) {
    addPaletteItem(type, config);
  }
}

function addPaletteItem(type, config) {
  const item = document.createElement('div');
  item.className = 'palette-item';
  item.draggable = true;
  item.innerHTML = `<span class="dot" style="background:${config.color}"></span>
    <span class="label">${config.label}</span>
    <span class="pins">${config.inputPins.length}→${config.outputPins.length}</span>`;
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', type);
    e.dataTransfer.effectAllowed = 'copy';
  });
  paletteList.appendChild(item);
}

// ─── Drag & Drop на канву ───────────────────────────────────────────
function initDragDrop() {
  svg.addEventListener('dragover', (e) => e.preventDefault());
  svg.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!type || !GATES[type]) return;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left - 45;
    const y = e.clientY - rect.top - 20;
    viz.addElement(type, Math.max(0, x), Math.max(0, y));
  });
}

// ─── Кнопки управления ─────────────────────────────────────────────
function initControls() {
  btnStep.addEventListener('click', () => { sim.step(); });

  btnReset.addEventListener('click', () => {
    sim.resetAll();
    if (viz) viz.updateStates();
    cycleDisplay.textContent = 'Такт: 0';
    setStatus('↺ Сброшено');
    log('Схема сброшена', 'info');
  });

  btnRun.addEventListener('click', () => {
    if (isRunning) {
      sim.stop();
      isRunning = false;
      btnRun.textContent = '▶ Запуск';
      setStatus('⏸ Остановлено');
    } else {
      sim.start(100);
      isRunning = true;
      btnRun.textContent = '⏸ Стоп';
      setStatus('▶ Симуляция запущена');
    }
  });
}

// ─── Кнопка компиляции ─────────────────────────────────────────────
function initCompileButton() {
  btnCompile.addEventListener('click', async () => {
    if (!monacoEditor) {
      log('⚠ Monaco ещё не загружен', 'err');
      return;
    }
    const code = monacoEditor.getValue();
    await compileCpp(code, { viz, GATES, log, setStatus, addPaletteItem });
  });
}

// ─── Клавиатурные сокращения ────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    switch (e.key) {
      case ' ':
        e.preventDefault();
        btnRun.click();
        break;
      case 's':
        if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); btnStep.click(); }
        break;
      case 'r':
        if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); btnReset.click(); }
        break;
      case 'Delete':
      case 'Backspace':
        if (viz && viz.selectedId) {
          e.preventDefault();
          const deleted = viz.selectedId;
          viz.deleteElement(deleted);
          log(`Удалён элемент #${deleted}`, 'info');
        }
        break;
    }
  });
}

// ─── Загрузка сохранённой схемы ────────────────────────────────────
function tryRestore() {
  const restored = loadState(viz, sim, log);
  if (restored) {
    setStatus(`↻ Восстановлено`);
  }
}

// ─── Инициализация всего приложения ─────────────────────────────────
log('🔄 SystemC Constructor загружается...', 'info');

initVisualConstructor();
buildPalette();
initDragDrop();
initControls();
initCompileButton();
initKeyboard();

// Monaco инициализируется через AMD — это неблокирующий callback
initMonaco();

// Восстанавливаем схему после того, как viz готов
tryRestore();

setStatus('Готово. Перетащите элементы на канву');
log('Приложение загружено. Space — пуск/стоп, S — шаг, R — сброс', 'info');
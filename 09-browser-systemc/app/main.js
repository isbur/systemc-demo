/**
 * Главный модуль приложения SystemC Constructor.
 * Оркестрирует Monaco, визуальный конструктор, симуляцию, компиляцию, сохранение.
 */
import { SimEngine, GATES } from './elements.js';
import { VisualConstructor } from './constructor.js';
import { version as jointVersion } from './vendor/joint/joint.js';
import { compileCpp, mountAutorunElement, restoreWasmSession } from './compiler.js';
import { scheduleSave, loadState, loadSource } from './persistence.js';
import { loadCells, cellSourceUrl } from './cells-runtime.js';

// ─── DOM refs ──────────────────────────────────────────────────────
const logPanel     = document.getElementById('log-panel');
const statusText   = document.getElementById('status-text');
const cycleDisplay = document.getElementById('cycle-display');
const paletteList  = document.getElementById('palette-list');
const paperHost    = document.getElementById('paper-host');

// Buttons
const btnCompile   = document.getElementById('btn-compile-cpp');
const btnStep      = document.getElementById('btn-step');
const btnReset     = document.getElementById('btn-reset');
const btnRun       = document.getElementById('btn-run');
const editorTitle  = document.getElementById('editor-title');
const btnEditorBack = document.getElementById('btn-editor-back');

// ─── Логирование ───────────────────────────────────────────────────
const sessions = [];

function log(msg, cls = 'line') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = cls === 'wasm' ? msg : `> ${msg}`;
  logPanel.appendChild(d);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function setStatus(text) {
  statusText.textContent = text;
}

// ─── Прогресс-бар ──────────────────────────────────────────────────
let progressBar = null;
let progressLabel = null;

function initProgressBar() {
  if (progressBar) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0;';
  
  progressLabel = document.createElement('span');
  progressLabel.style.cssText = 'font-size:0.7rem;color:#888;flex-shrink:0;min-width:100px;';
  progressLabel.textContent = '⏳ Загрузка...';
  
  const barOuter = document.createElement('div');
  barOuter.style.cssText = 'flex:1;height:8px;background:#222;border-radius:4px;overflow:hidden;';
  
  progressBar = document.createElement('div');
  progressBar.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#4fc3f7,#1565c0);border-radius:4px;transition:width 0.3s;';
  
  barOuter.appendChild(progressBar);
  wrap.appendChild(progressLabel);
  wrap.appendChild(barOuter);
  logPanel.appendChild(wrap);
}

function setProgress(value, max, label) {
  initProgressBar();
  const pct = Math.min(100, Math.round((value / max) * 100));
  progressBar.style.width = pct + '%';
  progressLabel.textContent = label || `⏳ ${pct}%`;
  if (pct >= 100) {
    setTimeout(() => {
      if (progressBar) {
        progressBar.style.width = '0%';
        progressLabel.textContent = '';
      }
    }, 1500);
  }
}

function hideProgress() {
  if (progressBar) {
    progressBar.style.width = '0%';
    progressLabel.textContent = '';
  }
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
//  SC_METHOD и SC_THREAD (pthread, каждый поток — Worker).
//  Канва вызывает init/step сообщениями в Worker.
//  Строка внизу консоли уходит в stdin модуля.
//
//  Обёртка канвы ждёт порты: clk, rst_n, enable, q — sc_uint<4>.

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
let userModel = null;
let cellModel = null;
let viewGen = 0;
let pendingSelection = undefined;
let saveFn = () => {};
const sourceCache = new Map();

function showUserModule() {
  viewGen++;
  pendingSelection = undefined;
  if (!monacoEditor || !userModel) return;
  monacoEditor.setModel(userModel);
  monacoEditor.updateOptions({ readOnly: false });
  editorTitle.textContent = '⚡ Monaco — C++/SystemC';
  btnEditorBack.hidden = true;
  btnCompile.disabled = false;
}

async function showCellSource(el) {
  if (!monacoEditor || !userModel) {
    pendingSelection = el || null;
    return;
  }
  const gen = ++viewGen;
  const url = el && cellSourceUrl(el.type, GATES);
  if (!url) {
    showUserModule();
    return;
  }
  let text = sourceCache.get(url);
  if (!text) {
    const response = await fetch(url);
    if (!response.ok) {
      log('Нет исходника ' + el.type, 'err');
      return;
    }
    text = await response.text();
    sourceCache.set(url, text);
  }
  if (gen !== viewGen || !monacoEditor) return;
  cellModel.setValue(text);
  monacoEditor.setModel(cellModel);
  monacoEditor.updateOptions({ readOnly: true });
  editorTitle.textContent = `${el.name} — SystemC`;
  btnEditorBack.hidden = false;
  btnCompile.disabled = true;
}

function initMonaco() {
  // Monaco AMD loader уже загружен (vs/loader.js в index.html)
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    const saved = loadSource();
    userModel = monaco.editor.createModel(saved ?? DEFAULT_CODE, 'cpp');
    cellModel = monaco.editor.createModel('', 'cpp', monaco.Uri.parse('inmemory://systemc-cell.cpp'));
    userModel.onDidChangeContent(() => saveFn());
    monacoEditor = monaco.editor.create(document.getElementById('monaco-container'), {
      model: userModel,
      language: 'cpp',
      theme: 'vs-dark',
      fontSize: 13,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
    if (saved !== null) log('Модуль восстановлен', 'ok');
    setStatus('Monaco Editor готов');
    log('Monaco Editor загружен', 'info');
    if (pendingSelection !== undefined) showCellSource(pendingSelection);
  });
}

// ─── Визуальный конструктор ─────────────────────────────────────────
function initVisualConstructor() {
  viz = new VisualConstructor(paperHost, sim);

  saveFn = scheduleSave(viz, sim, () => userModel?.getValue());

  viz.onEvent = (event, data) => {
    saveFn();
    if (event === 'element-placed') {
      setStatus(`➕ ${data.name}`);
      log(`Добавлен элемент: ${data.name} (${data.type})`, 'ok');
    }
    if (event === 'element-selected') showCellSource(data);
  };

  sim.on('connected', () => {
    saveFn();
    if (viz) viz.updateStates();
  });
}

// ─── Палитра элементов ──────────────────────────────────────────────
function buildPalette() {
  for (const [type, config] of Object.entries(GATES)) {
    addPaletteItem(type, config);
  }
}

let suppressPaletteClick = false;

function addPaletteItem(type, config) {
  const item = document.createElement('div');
  item.className = 'palette-item';
  item.draggable = true;
  item.dataset.type = type;
  item.title = 'Клик — на свободное место, или перетащите на канву';
  item.innerHTML = `<span class="dot" style="background:${config.color}"></span>
    <span class="label">${config.label}</span>
    <span class="pins">${config.inputPins.length}→${config.outputPins.length}</span>`;
  item.addEventListener('dragstart', (e) => {
    suppressPaletteClick = true;
    e.dataTransfer.setData('text/plain', type);
    e.dataTransfer.effectAllowed = 'copy';
  });
  item.addEventListener('dragend', () => {
    setTimeout(() => { suppressPaletteClick = false; }, 0);
  });
  item.addEventListener('click', () => {
    if (suppressPaletteClick) return;
    viz.addElement(type);
  });
  paletteList.appendChild(item);
}

// ─── Drag & Drop на канву ───────────────────────────────────────────
function initDragDrop() {
  const host = document.getElementById('canvas-wrap');
  host.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!type || !GATES[type]) return;
    const point = viz.clientToLocal(e.clientX, e.clientY);
    viz.addElement(type, point.x - 50, point.y - 24);
  });
}

// ─── Кнопки управления ─────────────────────────────────────────────
function initControls() {
  btnStep.addEventListener('click', () => { sim.step(); });

  btnReset.addEventListener('click', async () => {
    await sim.resetAll();
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
    const code = userModel ? userModel.getValue() : monacoEditor.getValue();
    await compileCpp(code, { viz, GATES, log, setStatus, addPaletteItem, setProgress, sessions });
  });
}

// ─── Клавиатурные сокращения ────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea') || e.target.closest('.monaco-editor')) return;
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
        if (!viz) break;
        {
          const removed = viz.deleteSelection();
          if (!removed) break;
          e.preventDefault();
          log(removed === 'link' ? 'Удалён провод' : 'Удалён элемент', 'info');
        }
        break;
    }
  });
}

// ─── Загрузка сохранённой схемы ────────────────────────────────────
function initStdin() {
  const form = document.getElementById('stdin-form');
  const input = document.getElementById('stdin-input');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const session = sessions[sessions.length - 1];
    if (!session) {
      log('stdin: сначала скомпилируйте модуль', 'err');
      return;
    }
    const line = input.value + '\n';
    try {
      session.pushStdin(line);
      log(line.replace(/\n$/, ''), 'stdin');
      input.value = '';
    } catch (error) {
      log(error.message, 'err');
    }
  });
}

async function tryRestore() {
  const wasmRestorer = async (uid, bytes) => {
    const view = viz.elementViews.get(String(uid));
    if (view && GATES[view.type]?.autorun) {
      await mountAutorunElement(
        view.el,
        bytes,
        (text) => log(text, text.startsWith('sc_main') ? 'ok' : 'wasm'),
        (text) => log(text, 'err'),
        sessions,
      );
      return null;
    }
    const session = await restoreWasmSession(bytes, (text) => log(text, 'wasm'), (text) => log(text, 'err'));
    sessions.push(session);
    return session;
  };
  const restored = await loadState(viz, sim, log, wasmRestorer);
  if (restored) {
    setStatus(`↻ Восстановлено`);
  }
}

// ─── Инициализация всего приложения ─────────────────────────────────
log('🔄 SystemC Constructor загружается...', 'info');

btnEditorBack.addEventListener('click', showUserModule);

async function boot() {
  try {
    const bytes = await loadCells();
    log(`Встроенные элементы: SystemC, ${(bytes / 1024).toFixed(0)} КБ`, 'ok');
  } catch (error) {
    log('SystemC-элементы не загрузились, остаётся JS: ' + error.message, 'err');
  }
  initVisualConstructor();
  buildPalette();
  initDragDrop();
  initControls();
  initCompileButton();
  initStdin();
  initKeyboard();
  try {
    initMonaco();
  } catch (error) {
    log('Monaco не загрузился: ' + error.message, 'err');
  }
  await tryRestore();
  setStatus('Готово. Клик — добавить блок, провод — от выхода к входу');
  log(`Канва: JointJS ${jointVersion}`, 'info');
  log('Клик добавляет блок на свободное место. Space — пуск/стоп, S — шаг, R — сброс, Delete — удалить', 'info');
}

boot();
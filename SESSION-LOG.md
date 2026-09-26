# SystemC Constructor — Лог сессии 2026-09-26

Хроника: рефакторинг, починка SC_ID_*, корутины, Clock-элемент, персистентность.
Git-коммиты в master отражают ключевые вехи.

---

## 1. Рефакторинг index.html (503 → 66 строк)
- Монолитный `app/index.html` (503 строки, стили + Monaco + WASI + компиляция + persistence) разбит на модули:
  - `app/style.css` — все стили
  - `app/wasi.js` — WASI preview1 polyfill (полная таблица импортов)
  - `app/compiler.js` — компиляция C++/SystemC → WASM через `@yowasp/clang`
  - `app/persistence.js` — localStorage save/load схемы
  - `app/main.js` — оркестрация Monaco/SimEngine/Viz/кнопки/клавиатура
  - `app/index.html` — только HTML-скелет

- Monaco-пример исправлен: `#include "systemc.h"` (кавычки, а не `<>`)
- Убрана бажная нормализация `#include "sysc/..."` → `"..."`

**Коммит:** `625750d refactor: split monolithic index.html into modules`

## 2. Сборка systemc-unity.o — проблема SC_ID_* и корутин

### Попытка unity-сборки
- `build-artifacts.mjs` — скрипт генерации `systemc-vfs.json` + `systemc-unity.o`
- SystemC 3.0.2, `--target=wasm32-wasip1`, `-fvisibility=default`
- `__cxa_*` stubs для исключений (Itanium ABI)
- Исключены `sc_cor_pthread.cpp` / `sc_cor_qt.cpp` (не нужны для SC_METHOD)

### Include guard баг
- `sc_utils_ids.cpp` определяет SC_ID_* константы через `#define SC_DEFINE_MESSAGE`
- В unity-сборке `systemc.h` включает `sc_kernel_ids.h` ПЕРВЫМ → include guard
- `sc_utils_ids.cpp` не может пере-включить заголовки с DEFINITION-формой
- **Фикс:** компилировать `sc_utils_ids.cpp` отдельно в `sc_ids.o`

### Корутины
- `-DSC_USE_PTHREADS` тянет `sc_cor_pthread.h` → `<pthread.h>` не существует для WASI
- Без `SC_USE_PTHREADS` → `sc_cor_qt.h` → QuickThreads (setjmp/longjmp, нет для WASM)
- **Решение:** своя заглушка `sc_cor_wasm.h` / `sc_cor_wasm.cpp` — `sc_cor_pkg_wasm` с пустыми методами
- Патчинг `sc_simcontext.cpp` в VFS: заменяем `#include "sc_cor_pthread.h"` и др. на `#include "sc_cor_wasm.h"`

### Схема артефактов
- `app/sc_ids.o` (35 KB) — SC_ID_* definitions (sc_utils_ids.cpp)
- `app/systemc-core.o` (1.4 MB) — всё остальное (83 .cpp, без coroutines)
- `app/systemc-vfs.json` (2.6 MB) — дерево заголовков для VFS

**Коммит:** `1caa79c feat: build-artifacts.mjs`
**Коммит:** `cd38088 feat: персистентность WASM-элементов`

## 3. Первый успешный тест кольцевого регистра

- `test-pipeline.mjs` — сквозной тест: компиляция + линковка + инстанциирование
- `systemc-core.o + sc_ids.o + main.cc → module.wasm` (2.6 MB)
- `init() → OK, reset → q=1, step 1..8 → 1,2,4,8,1,2,4,8 ✅`
- **Ключевой фикс:** `sc_start(SC_ZERO_TIME)` убран из `init()` → deferred to `step()`/`reset_ring()`
- `__cxa_begin_catch` — правильная сигнатура `void*` (была `void` → mismatch)
- `-fno-exceptions` для пользовательского кода
- `--initial-memory=33554432` (32 MB)

**Коммит:** `09a5e74 feat: SystemC → WASM в браузере — кольцевой регистр работает!`

## 4. Прогресс-бар загрузки LLVM

- `prefetchLLVM()` — предзагрузка 4 WASM-чанков yowasp (105 MB) с прогрессом
- **Cache API:** `caches.open('llvm-chunks-v1')` — чанки сохраняются между перезагрузками
- Скачивание последовательное (не `Promise.all`) — точный прогресс без race condition
- `setProgress(pct, 100, label)` — DOM-прогресс-бар в лог-панели

**Коммит:** `8df0e86 feat: прогресс-бар загрузки LLVM`

### Баги и фиксы
- `RangeError: source array is too long` — `String.fromCharCode(...Uint8Array)` падает на 2.6 MB
  → **фикс:** разбивка на чанки по 8 KB
- `RangeError: too many function arguments` — то же в persistence.js при base64
  → **фикс:** chunk-encoding

**Коммит:** `4e9eef3 fix: RangeError source array too long`
**Коммит:** `43e5150 fix: RangeError too many function arguments`

## 5. Clock-элемент + pin-level edge detection

### Проблема: глобальный такт
- Раньше: SimEngine дёргал `clockEdge('pos')` для ВСЕХ sequential элементов
- Пользователь хотел ВИЗУАЛЬНЫЙ Clock-элемент на канве

### Решение: детекция фронта по пинам
- **Clock** — новый элемент в палитре (выход `clk`, переключается каждый step)
- **SimEngine.step()** переработан:
  1. Сохраняем `el.inputs._prevInputs = {...el.inputs}`
  2. Clock-элементы переключаются
  3. Пропагация Clock-изменений по соединениям
  4. Дельта-циклы (Clock исключён)
  5. Все элементы детектят rising edge через `inp._prevInputs.clk === 0 && inp.clk === 1`
- **VCC** (1) и **GND** (0) — константы для подтяжки enable/rst_n
- `rst_n` — сброс по спадающему фронту (1→0), не по статическому 0
- `isSequential` / `_clockEdgeFn` удалены

### Баги и фиксы
- `_prevInputs` сохранялся в `el._prevInputs`, а evaluate читал из `inp._prevInputs` (= `this.inputs._prevInputs`) → разные объекты, фронт не детектился
  → **фикс:** `el.inputs._prevInputs = {...el.inputs}`
- Clock участвовал в дельта-циклах → переключался 20 раз за step → phase всегда 0
  → **фикс:** `if (el._isClock) continue;` в дельтах

**Коммит:** `d87367d feat: Clock-элемент + pin-level edge detection`
**Коммит:** `8010bfc fix: _prevInputs сохранялся на el, а читался с inp`
**Коммит:** `f4e59b2 fix: Clock не должен участвовать в дельта-циклах`

## 6. Пины SysC-элемента

- Входы: `clk`, `rst_n`, `enable` (было `in0..in7`)
- Выходы: `q0`, `q1`, `q2`, `q3` (было `out0..out3`)
- Обработка reset по спадающему фронту `rst_n`
- Детекция rising edge на `clk`

## 7. Персистентность WASM-элементов

- `saveState()` — base64-кодирует все `_wasmBinary` и хранит в localStorage
- `loadState()` — декодирует, реинстанциирует WASM, восстанавливает `_evaluateFn`
- `restoreWasmExports(base64)` — `export` из `compiler.js`
- Схема с SysC-элементом восстанавливается после перезагрузки

**Коммит:** `cd38088 feat: персистентность WASM-элементов`

---

## Текущее состояние

### ✅ Работает
1. **Компиляция SystemC → WASM в браузере** через `@yowasp/clang` (LLVM 22, 105 MB)
2. **Кольцевой регистр** — 1→2→4→8→1... в WASM через `sc_start()`
3. **Прогресс-бар** загрузки LLVM (Cache API — не качается повторно)
4. **Clock-элемент** на канве — соединение проводами к `clk` входу
5. **VCC/GND** — константы для enable/rst_n
6. **Персистентность** — схема + WASM сохраняются в localStorage
7. **Пины** — осмысленные имена (`rst_n`, `enable`, `q0..q3`)

### ❌ Известные проблемы
- `sc_start()` в `init()` вызывает `memory access out of bounds` (обход: deferred to step/reset)
- Схема с Clock → SysC не тестировалась end-to-end после последнего фикса `_prevInputs`

### Файловая структура приложения

| Файл | Назначение |
|---|---|
| `app/index.html` | HTML-скелет (67 строк) |
| `app/main.js` | Оркестрация: Monaco, SimEngine, кнопки |
| `app/compiler.js` | Компиляция C++/SystemC → WASM |
| `app/elements.js` | SimEngine, LogicElement, GATES (Clock, VCC, GND...) |
| `app/constructor.js` | SVG-канва, drag & drop, соединения |
| `app/wasi.js` | WASI preview1 polyfill |
| `app/persistence.js` | localStorage save/load (включая WASM) |
| `app/style.css` | Все стили |
| `app/sc_ids.o` | SC_ID_* definitions (35 KB) |
| `app/systemc-core.o` | SystemC без coroutines (1.4 MB) |
| `app/systemc-vfs.json` | Дерево заголовков (2.6 MB) |

### Инфраструктура сборки

| Файл | Назначение |
|---|---|
| `build-artifacts.mjs` | Генерация `.o` + `vfs.json` из `app/systemc-src/` |
| `build-core.mjs` | Быстрая пересборка `systemc-core.o` |
| `test-pipeline.mjs` | Сквозной тест компиляции + линковки |
| `pixi.toml` | pixi-таски: `build-artifacts`, `serve-web` |

### Git-лог (текущая сессия)
```
625750d refactor: split monolithic index.html into modules
1caa79c feat: build-artifacts.mjs — генерация systemc-vfs.json и systemc-unity.o
09a5e74 feat: SystemC → WASM в браузере — кольцевой регистр работает!
8df0e86 feat: прогресс-бар загрузки LLVM в консоли приложения
4e9eef3 fix: RangeError source array too long при загрузке LLVM
cd38088 feat: персистентность WASM-элементов в localStorage
43e5150 fix: RangeError too many function arguments при base64 WASM
d87367d feat: Clock-элемент + pin-level edge detection
8010bfc fix: _prevInputs сохранялся на el, а читался с inp
f4e59b2 fix: Clock не должен участвовать в дельта-циклах
```
# SystemC Constructor — состояние на 2026-09-26

## Главная цель ✅
SystemC компилируется в WASM прямо в браузере (без сервера).
Кольцевой регистр работает: `init() → reset → 1,2,4,8,1,2,4,8`

## Архитектура

### Компиляция
```
main.cc (user code + wrapper) + sc_ids.o + systemc-core.o
    → clang++ (@yowasp/clang, LLVM 22 in WASM, 105 MB)
    → module.wasm (2.6 MB)
```

### Артефакты (предсобраны, лежат в app/)
- `sc_ids.o` — SC_ID_* definitions (sc_utils_ids.cpp отдельно)
- `systemc-core.o` — все 83 .cpp SystemC (исключены корутины)
- `systemc-vfs.json` — дерево заголовков для VFS

### WASI
- `@yowasp/clang` для `--target=wasm32-wasip1` включает wasi-libc + libc++
- Наша polyfill: полная таблица WASI preview1 (fd_write, fd_read, poll_oneoff...)

### WASM-заглушки
- **Корутины:** `sc_cor_wasm.h/.cpp` — пустая реализация `sc_cor_pkg`
- **Исключения:** `__cxa_*` stubs с корректными Itanium ABI сигнатурами

### Cache API
- LLVM чанки (4 × ~26 MB) кэшируются в `caches.open('llvm-chunks-v1')`
- При повторной загрузке страницы — 0% трафика, «✅ LLVM (из кэша)»

## Визуальный конструктор

### Элементы палитры
| Элемент | Пины | Описание |
|---|---|---|
| Clock | → clk | Тактовый генератор (toggles each step) |
| VCC | → y | Постоянная 1 |
| GND | → y | Постоянная 0 |
| AND/OR/NOT/NAND/NOR/XOR | a,b → y | Базовые вентили |
| D-FF | clk,d,rst_n → q,qn | Триггер с детекцией rising edge |
| Ring Ctr | clk,rst_n,enable → q0..q3 | Кольцевой регистр |
| Counter | clk,rst_n,enable → q0..q3 | 4-битный счётчик |
| MUX 2→1 / MUX 4→1 | sel,... → y | Мультиплексоры |
| Half Add | a,b → sum,carry | Полусумматор |
| SysC | clk,rst_n,enable → q0..q3 | Скомпилированный WASM-модуль |

### Детекция фронта
- SimEngine.step(): Clock toggle → propagation → delta cycles
- Все элементы детектят `inp._prevInputs.clk === 0 && inp.clk === 1`
- `rst_n` — сброс по спадающему фронту (1→0)
- `isSequential` / `_clockEdgeFn` удалены

### Персистентность
- Схема + WASM-бинарники (base64) в localStorage
- После перезагрузки WASM реинстанциируется, _evaluateFn восстанавливается

## Файлы

### Приложение
| Файл | Строк |
|---|---|
| `app/index.html` | 67 |
| `app/main.js` | ~295 |
| `app/compiler.js` | ~325 |
| `app/elements.js` | ~350 |
| `app/constructor.js` | 450 |
| `app/wasi.js` | 61 |
| `app/persistence.js` | 119 |
| `app/style.css` | 147 |

### Инфраструктура
| Файл | Назначение |
|---|---|
| `build-artifacts.mjs` | Сборка .o + vfs.json |
| `build-core.mjs` | Быстрая пересборка systemc-core.o |
| `test-pipeline.mjs` | Сквозной тест |
| `pixi.toml` | pixi run build-artifacts, serve-web |

## Команды
```bash
pixi run serve-web        # python3 http.server :8080
node build-artifacts.mjs  # пересобрать .o + vfs.json
node test-pipeline.mjs    # сквозной тест компиляции + линковки
```

## Известные проблемы
1. `sc_start()` в `init()` → memory access out of bounds (обход: deferred to step/reset)
2. Clock → SysC end-to-end не тестирован после последнего фикса `_prevInputs`
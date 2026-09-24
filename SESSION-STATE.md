# SystemC Constructor — обновление сессии

Дата: 2026-09-24 (продолжение). Рабочая директория: `/home/redcoon/work/systemc`

## Исследование: @yowasp/clang (LLVM 22.1.0 в WASM)

### Вывод: @yowasp/clang НЕ может собрать SystemC в WASM

**Причина:** @yowasp/clang (clang 22 в WASM через YoWASP) включает в ресурс-тар только:
- libc++ headers (`/usr/include/c++/v1/`)
- clang builtin headers

Но **НЕ включает wasi-libc** (заголовки C-библиотеки: `math.h`, `stdlib.h`, `stdio.h` и т.д.).
При компиляции `<cmath>` → libc++ ищет `<math.h>` → не находит в ресурс-таре →
фолбечится на glibc хоста (в данном случае `/usr/include/math.h`) →
Feature-тесты (FP_NAN, FP_INFINITE) не проходят для WASI-target → ошибки компиляции.

### Ключевые находки
1. **stdin через RunOptions, не через `files['stdin']`**: правильный API — `{stdin: (len) => Uint8Array|null}`
2. **stdin-режим отличается от named-file**: `clang++ -x c++ - unity.cc` даёт ошибку даже для простого `#include "systemc.h"`, а stdin (даже неправильно переданный) «проходил» — ложное срабатывание
3. **VFS с вложенными деревьями работает**: `{ sysc: { kernel: { sc_event.cpp: ... } } }` успешно резолвит `#include "sysc/kernel/sc_event.cpp"`
4. **Бинарные файлы в VFS через Uint8Array не работают**: .a/.o файлы clang пытается парсить как C++ код
5. **`-nostartfiles -nodefaultlibs`** позволяют линковать WASM без libc (если код их не использует), но SystemC активно использует `operator new`, `std::vector`, `std::cout` и т.д.

### Что нужно для работы SystemC в браузере через @yowasp/clang
- wasi-libc заголовки (`math.h`, `stdlib.h`, ...) — либо в ресурс-таре, либо в VFS
- runtime-библиотеки: `libc.a`, `libc++.a`, `libc++abi.a`, `libclang_rt.builtins.a`
- Эти библиотеки можно собрать отдельно под wasm32-wasi

## План B: emscripten (работает, известная проблема)

Emscripten 4.0.9 установлен (`~/.pixi/envs/default/lib/emscripten-4.0.9/em++`).
Имеет полноценный wasm-тулчейн с libc (musl) и libc++.

### Предыдущая попытка
`em++ ... -s STANDALONE_WASM -o ring_counter_emcc.wasm` скомпилировалась успешно,
но упала на `wasm-opt` (бинарный оптимизатор был версии 117, emscripten ожидал 123).

Фикс: `-s WASM_OPT=0 -s ERROR_ON_WASM_OPT=0`

### Предсобранные артефакты
- `build-wasm/src/libsystemc.a` — SystemC, собранный Emscripten для wasm32-emscripten
- `ring_counter.wasm` / `ring_counter.js` — первая рабочая сборка
- `wasm_main.cpp` — интерактивная обёртка (init/step/reset_ring/get_q/set_enable)

## Файлы, добавленные в этой сессии
| Файл | Назначение |
|---|---|
| `build-unity.mjs` | unity-подход через @yowasp/clang (не работает из-за FP_NAN) |
| `build_systemc.mjs` | правильный stdin-подход через RunOptions (FP_NAN блокер) |
| `test-minimal.mjs` | тест минимального stdin (работает без systemc.h) |
| `test-header-compile.mjs` | тест VFS headers (не использовался) |
| `test-incremental.mjs` | тест с добавлением VFS по частям |
| `test-full.mjs` | тест с полным VFS дерева |
| `test-vendor.mjs` | тест с vendor/ поддиректорией |
| `test_minimal.mjs` | минимальный успешный тест @yowasp/clang |
| `test_stdin.wasm` | валидный .wasm (простая C++ функция, 392 байта) |
| `ring_counter_yowasp.o / .wasm` | промежуточные артефакты @yowasp/clang |

## Следующий шаг
Скомпилировать кольцевой регистр через emscripten:
```bash
em++ -std=c++17 -o ring_counter_emcc.wasm wasm_main.cpp \
  -L build-wasm/src -lsystemc \
  --no-entry -s STANDALONE_WASM -s WASM_OPT=0 \
  -s EXPORTED_FUNCTIONS='[_init,_step,_reset_ring,_get_q,_set_enable]' \
  -I systemc-src/src -O2 -fvisibility=default -fno-threadsafe-statics
```
Проверить: `node --input-type=module -e "WASI instantiation + init/step тесты"`
# SystemC Constructor — выжимка сессии (передать след. агенту)

Дата: 2026-09-24. Рабочая директория: `/home/redcoon/work/systemc`

## Цель
Веб-конструктор цифровых схем: готовые элементы + Monaco-редактор для C++/SystemC,
компиляция в WASM и запуск симуляции. Изначально хотели «всё в браузере, без сервера».

## Окружение
- Установлено через **pixi** (`.pixi/envs/default`): systemc 3.0.2 (нативный + заголовки),
  emscripten 4.0.9 (emcc), cmake, ninja.
- Отдельная pixi-среда `tools-llvm8/` — clang 8.0.1 + wasm-ld 8 + llvm-ar (для экспериментов с WASI).
- `@yowasp/clang` (LLVM 22 в WASM, `node_modules/`) — **готовый браузерный тулчейн**, работает.
- Node.js v26 (используем `node:wasi` preview1 для тестов).
- Git-репозиторий в корне проекта; полезные коммиты в `master`.

## Что построено (файлы)
| Файл | Роль |
|---|---|
| `app/index.html` | SPA: палитра, SVG-канва, Monaco, кнопки. Склеивает всё |
| `app/elements.js` | SimEngine (дельта-циклы) + LogicElement + 12 готовых вентилей (AND/OR/NOT/NAND/NOR/XOR/DFF/RING4/COUNTER4/MUX2/MUX4/HALF_ADDER) |
| `app/constructor.js` | SVG-канва: drag&drop, соединения пинов, удаление, сериализация |
| `compile-server.mjs` | микросервис: POST /compile {code,name} → {wasm base64} через @yowasp/clang |
| `build-wasm/` | libsystemc.a собранный под Emscripten + ring_counter.js/wasm |
| `ring_counter.js/.wasm` | первая рабочая сборка (эcmc) кольцевого регистра — ок |
| `wasm_main.cpp` | интерактивная обёртка для emscripten-сборки (init/step/reset/get_q) |
| `app/systemc-unity.o` | SystemC в WASM unity-объект (середина сессии, см. ниже) |
| `app/systemc-vfs.json` | 217 заголовков SystemC (флaтт für flatten-подход; устарел) |

## Готовые элементы (JS) — РАБОТАЮТ
- 12 вентилей, симуляция `SimEngine.step()`, SVG-конструктор, localStorage-персист.
- В `app/index.html`: Space=run, S=step, R=reset, Delete=удалить.

## Голый C++ (без SystemC) — РАБОТАЕТ в браузере
Через `@yowasp/clang`:
```js
const { runClang } = await import('https://cdn.jsdelivr.net/npm/@yowasp/clang/+esm');
const result = await runClang(['clang++','-std=c++17','module.cc','-o','module.wasm',
   '-Wl,--no-entry,--export=...','--target=wasm32-wasi','-O2'], {'module.cc': code});
```
Проверено: компилирует, инстанцируется в браузере с WASI-заглушками `makeWasiPreview1()`.

## SystemC в браузере — ПРОБЛЕМА, почти решена
### Ключевое открытие про VFS runClang
- **VFS-ключи со слэшами (`sysc/kernel/sc_event.cpp`) НЕ работают.**
- **Вложенные объекты-деревья работают**: `{ sysc: { kernel: { sc_event.cpp: '...' } } }`
  и в аргументах clang пишем `sysc/kernel/sc_event.cpp` — **находит**.
- `#include "sysc/kernel/sc_module.h"` находит в дереве (пути сохраняются).

### Текущий способ (работал в тесте, остался один сбой)
1. `buildTree(SRC/sysc)` → VFS-дерево (включая systemc.h, systemc файл без расширения)
2. unity.cc = все `*.cpp` через `#include "sysc/.../foo.cpp"` + пользовательский код + обёртка
   (обёртка: `noexcept sc_main`, глобальные сигналы-указатели, `extern "C" init/step/reset_ring/get_q/set_enable`)
3. `clang++ unity.cc -o out.wasm -Wl,--no-entry,--export=init,... -I. -DSC_USE_PTHREADS -fno-threadsafe-statics -O2`
Компиляция проходила (только warning SC_DEFINE_MESSAGE redefine). Линковка падала:

```
wasm-ld: undefined symbol: sc_core::SC_ID_GEN_UNIQUE_NAME_ ...
```

### Причина (нашёл в выводе cc1): `-fvisibility=hidden` у clang
- В отладочном выводе clang line: `-fvisibility=hidden`. Константы `SC_ID_*` объявлены
  без видимости → линковщик их не видит → undefined при линковке.
- **Фикс (не проверен):** добавить `-fvisibility=default` или `-Wl,--export-dynamic`.
  Это следующий шаг для SystemC в браузере.

## Микросервис (компиляция SystemC на сервере) — РАБОТАЕТ
`node compile-server.mjs 3082` + эмccripten-сборка SystemC (кольцо `[1,2,4,8]` — PASSED).
Пользователь склонялся к «всё в браузере», микросервис — запасной вариант.

## Ошибки во время сессии (урок)
- `@yowasp/clang` runClang VFS НЕ видит flat-заголовки по путям — только древовидную VFS.
- `SC_THREAD`/`wait()` не поддерживаются в WASI (нет pthread) — только SC_METHOD.
- emulate-порты CDN(wasm-clang@0.0.1) — устаревший clang 8 + кривые libc++, не использовать.
- Сборка LLVM в WASM вручную — неделимая задача; готовый `@yowasp/clang` решает.

## Следующий шаг (по приоритету)
1. (5 мин) В index.html SystemC-ветка: добавить `-fvisibility=default` к clang args
   unity-подхода (уже есть код) → проверить, что SC_ID_* линкуется.
2. (10 мин) Если ок: инстанцировать out.wasm в браузере (wasi-заглушки preview1)
   и повесить на канву как `wasm-module` (паттерн уже в index.html).
3. (опц.) Сгенерировать VFS-дерево (не flat!) прямо в браузере через fetch/JSON,
   чтобы не таскать 70+ .cpp; либо заин-линить unity в один большой .cc.

## Команды
```
pixi run serve-web                 # python http.server :8080 → http://127.0.0.1:8080/app/index.html
node compile-server.mjs 3082       # микросервис: POST http://127.0.0.1:3082/compile
```
Тест runClang: `node --input-type=module -e "import{runClang}from'@yowasp/clang';..."`.

## Важно для след.агента
- НЕ стирать `app/systemc-unity.o` и `app/systemc-vfs.json` без надобности.
- При тесте в browser: первый запуск грузит 105 MB LLVM — терпеливо.
- Загляни в git log — история коммитов кратко описывает путь.
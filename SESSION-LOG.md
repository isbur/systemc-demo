# SystemC Constructor — Подробный лог сессии

Хроника от начала переписки, включая тупиковые ветки.
Git-коммиты в master отражают ключевые вехи.

---

## 1. Установка SystemC через pixi
- Проверили: `pixi 0.76.2` установлен в `~/.pixi/bin`.
- `pixi search systemc` → conda-forge: **systemc 3.0.2** (заголовки systemc.h/systemc, libsystemc.so, doc).
- Создали `pixi.toml` (workspace `systemc-ring-counter`, канал conda-forge, linux-64).
- `pixi install` → сработал (первые 2 раза валился из-за read-only закэша
  `/home/redcoon/.cache/rattler` — позже научились переопределять `XDG_CACHE_HOME`/`RATTLER_CACHE_DIR`).
- Написали **кольцевой регистр** на SystemC: `ring_counter.h` (SC_MODULE, sc_in/sc_out,
  SC_METHOD shift_proc) + `tb_ring_counter.h` + `main.cpp`.
- Собрали и запустили нативно: `pixi run build` → симуляция дала
  `1,2,4,8,1,2,4,8` — PASSED.

## 2. Первый вопрос про «графическую обёртку»
- Пользователь: статическое веб-приложение для визуализации.
- Я предложил варианты: WASM-порт SystemC / чистый JS-визуализатор / React.
- Пользователь уточнил: интересует реальный C++ в браузере, «через понятие WASM».

## 3. Сборка SystemC в WASM через Emscripten (рабочая ветка!)
- Поставили **emscripten 4.0.9** через pixi (в тот же env).
- `emcmake cmake ../systemc-src -DBUILD_SHARED_LIBS=OFF` → `emmake make` → **libsystemc.a (wasm)**.
- Написали `wasm_main.cpp` (интерактивная обёртка: `extern "C" init/reset_ring/step/get_q/set_enable`,
  SC_METHOD для кольцевого регистра).
- `emcc ... -sINVOKE_RUN=0 -sNO_EXIT_RUNTIME` → `ring_counter.js` + `ring_counter.wasm`.
- Проверка в Node: `[1,2,4,8,1,2,4,8]` — **PASSED**. Это первая работающая связка «SystemC в WASM».
- Сделали `shell.html` — веб-страница с 4 битами + кнопки Step/Run/Reset + мини-диаграмма.

## 4. Идея конструктора «из готовых элементов + Monaco»
- Пользователь: универсальный конструктор, кастомные элементы через Monaco.
- Проговорили: статический веб без сервера vs с компиляцией.
- Я начал строить SPA: `app/index.html` + `app/elements.js` + `app/constructor.js`.

## 5. Попытка in-browser компиляции C++ (тупик 1: wasm-clang 8.0.1)
- Искали clang.wasm для браузера.
- Нашли `@eduoj/wasm-clang` (CDN `wasm-clang@0.0.1`, clang **8.0.1**, lld 8.0.1).
- Пытались скомпилировать SystemC через clang -cc1 + wasm-ld в браузере.
- Проблемы (убившие ветку):
  - `Cannot select: AtomicLoad` — clang 8.0.1 backend не умеет атомики
    (thread-safe static init), нужен `-fno-threadsafe-statics`.
  - `undefined symbol: __cxa_*` — CDN-ный libc++abi 2019 без исключений.
  - `Bad section type` у `wasm-ld 8` на объектах нового формата (DATACOUNT).
- Вывод: старый тулчейн из CDN сломан, чинить нереально.

## 6. Конструктор и Monaco (работает, но были фиксы)
- Собрали палитру (AND/OR/NOT/NAND/NOR/XOR/DFF/RING4/COUNTER4/MUX2/MUX4/HALF_ADDER),
  SVG-канва, соединения, drag&drop, удаление через Delete, localStorage.
- Баги исправлены:
  - CommonJS `module.exports` → ES `export` (палитра была пустой).
  - `Symbol` в dataset → строка (перетаскивание).
  - Дубль `let monacoEditor` (SyntaxError redeclaration).
  - Табы (рекламировали) убраны → Monaco просто виден.
  - JS-кнопка удалена (пользу требовал только C++).
- `pixi run serve-web` → http://127.0.0.1:8080/app/index.html.

## 7. Сборка libsystemc под WASI (тупик 2: clang 8 + кривые libc)
- Для браузерной компиляции нужен был `.o/.a` под wasm32-wasi (не emscripten).
- Скачали WASI sysroot из CDN (wasm-clang@0.0.1/bin/sysroot.tar).
- `build-wasi.sh` (clang 21 из pixi) → много ошибок:
  - `pthread.h not found` → сделали заглушку pthread.h в был-sysroot.
  - без `-fno-threadsafe-statics` → атомики.
  - `sc_cor_pthread.cpp` тянул pthread API → заглушка корутин.
  - `sc_cor_qt.cpp` тянул QuickThreads → заглушка qt.
  - `Bad section type` (DATACOUNT) — даже libsystemc от clang 8 линкуется
    только былъ-ld 8 (см. п.5).
- Дальше: собранный нами `libc++ 8.0.1` не собирался (cstring/memcpy include-проблемы,
  `#include_next` не находил `<string.h>`), а CDN-ный libc++ имел сигнатурные конфликты
  (`ios.cpp` vs `iostream.cpp`) — modern валидатор (wasmer) ловил `type mismatch`.
- **Тупик.** Даже clang 8 + был-ld 8 + свои libc не давали стабильной картинки.
- Бонус из тупика: установили **wasmer** (бинарник с GitHub), и он подтвердил:
  `event/sc_start` в SystemC работают с полным WASI, значит у нас были проблемы
  из-за кривого libc++, не SystemC.

## 8. Микросервис (рабочая ветка 2)
- Написали `compile-server.mjs`: POST /compile {code,name} → компиляция через pixi env
  (emcc + libsystemc.a) → возврат {wasm base64, js}.
- Чинили:
  - spawn вместо execSync (не блокировать).
  - `-s EXPORTED_FUNCTIONS=[...]` через массив аргументов (кавычки).
  - `int sc_main(){...}` для линковки (иначе `undefined symbol: sc_main`).
  - был-opt несовместим → заглушка wasm-opt ({1..priority}) и `SINGLE_FILE=1`.
- Итог: SystemC кольцевой регистр через микросервис — `[1,2,4,8]` PASSED
  (полноценный SystemC, интерактивные шаги).

## 9. Аренда сервера для сборки свежего clang.wasm (тупик 3)
- Пользователь арендовал VPS (14 ядер, 62 ГБ), дал ключ `id_ed25519_fuxi`.
- Развернули pixi+emscripten, клонировали LLVM (через Gitee из-за медленного GitHub),
  запустили сборку.
- Шквал CMake-ошибок: libstdc++ check, атомики, shared-libs (LTO/clang-shlib),
  TableGen — каждой добавлен флаг, но это бесконечная карусель.
- Пользователь отключил сервер (не хотел платить), сборку прекратили.

## 10. Открытие: @yowasp/clang (решение!)
- Пользователь скинул `https://cdn.jsdelivr.net/npm/@yowasp/clang/gen/bundle.js`.
- Пиф: `@yowasp/clang@22.0.0-git...` — **полный LLVM/Clang/LLD 22, собранный whitequark в WASM**,
  105 МБ unpacked. Доступен в браузере и Node.
- Читаем README: API `runClang(args, filesIn, options)`, VFS filesIn (строки/Uint8Array/деревья),
  returns filesOut. При ненулевом exit бросает `Exit` c `.files`.
- Голый C++ пример с `iostream` — **работает** (sysroot встроен).

## 11. Попытки SystemC через runClang (тупик 4 → почти прорыв)
- `#include <systemc.h>` — clang его не находил.
- Пробовали "гните заголовки" в VFS (плоско) — не находил include-файлы.
- Пробовали вложенные объекты VFS (`{sysc:{kernel:{...}}}`) — **нашлось!**
  Ключи со слэшами не работают, а деревья работают.
- unity.cc = `#include "sysc/.../foo.cpp"` для всех .cpp + юзер-код:
  - компиляция проходит (warning SC_DEFINE_MESSAGE redefine),
  - линковка: `undefined sc_core::SC_ID_GEN_UNIQUE_NAME_` и др.
- Нашли в отладочном выводе cc1: `-fvisibility=hidden`, поэтому константы
  не видит был-ld. **Фикс не проверен:** `-fvisibility=default` или `-Wl,--export-dynamic`.
- Текущее состояние index.html: ветка SystemC грузит unity.o + VFS json (старый путь),
  но фактически рабочий путь — добавить `-fvisibility=default` и деревянную VFS.

## 12. Завершение сессии
- Создан `SESSION-STATE.md` (краткое состояние) и этот `SESSION-LOG.md`.
- Зафиксированы коммиты в git (история в логе коммитов).

---

## Полезные «заповеди» из этой сессии
1. **Инструменты:**
   - Браузерный C++/SystemC-компилятор → `@yowasp/clang` (LLVM 22).
   - `runClang` VFS: только деревья объектов (не flat-ключи со слэшами).
   - Ненулевой exit → бросает `Exit` с `.files` (там stderr/вывод).
2. **SystemC:**
   - SC_THREAD/wait() не работают в WASI — только SC_METHOD.
   - Константы SC_ID_* требуют видимости (fix: `-fvisibility=default`).
3. **Emscripten (для сервера/сборки .wasm):** работает стабильно,
   но выдаёт свой ABI (env-импорты), не WASI.
4. Старый CDN `wasm-clang@0.0.1` + clang 8 — мусор, не тратить время.
5. Собирать LLVM в WASM вручную — дни работы; не нужно, есть готовый @yowasp/clang.

## Куда дальше (по приоритету)
1. В index.html: для SystemC использовать деревянную VFS + unity.cc + `-fvisibility=default`.
2. Проверить линковку SC_ID_*; если ок — инстанцировать wasm и вешать на канву.
3. Если fvisibility не поможет — альтернатива: `-Wl,--export-dynamic`, либо
   определить SC_ID через макрос SC_DEFINE_MESSAGE с текстом (как делает sc_utils_ids.cpp).
4. Отдельно: микросервис compile-server.mjs всё ещё рабочий fallback на сервер.
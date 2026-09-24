#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Сборка свежего clang.wasm + lld.wasm (LLVM → WebAssembly/WASI)
#  Запускать на мощном сервере (16+ ядер, ~100ГБ диска, ~32ГБ RAM).
#  Ожидаемое время: 2-6 часов (зависит от железа).
#
#  Осн. источник: https://clang.llvm.org/docs/ClangLLVMBrowser.html
#
#  Результат (в <root>/out/):
#    clang.wasm  lld.wasm  ...
#  Дальше кладём их в браузер вместо старых 8.0.1 из wasm-clang CDN.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LLVM_SRC="$ROOT/llvm-src"
BUILD_DIR="$ROOT/build-clang-wasm"
OUT_DIR="$ROOT/out"
JOBS="${JOBS:-$(nproc)}"

echo "→ ROOT=$ROOT, JOBS=$JOBS"

# ── 1. Клонируем LLVM (лучше от YoWASP форка — там уже патчи под WASI) ─────
#     Ещё вариант: официальный https://github.com/llvm/llvm-project
if [ ! -d "$LLVM_SRC/.git" ]; then
    echo "→ Клонируем LLVM (формач YoWASP для WASI)..."
    git clone --depth 1 https://codeberg.org/YoWASP/llvm-project.git "$LLVM_SRC" || \
    git clone --depth 1 https://github.com/llvm/llvm-project.git "$LLVM_SRC"
fi

# ── 2. Нужен Emscripten (версия >= 3.x; 4.x ок) ─────────────────────────────
#     Здесь предполагается что emcc/emcmake/emmake в PATH. Если нет:
#     pixi init && pixi add emscripten
command -v emcmake >/dev/null || { echo "нет emcmake — нужен Emscripten"; exit 1; }
command -v emmake >/dev/null || { echo "нет emmake — нужен Emscripten"; exit 1; }

# ── 3. Настраиваем сборку ───────────────────────────────────────────────────
rm -rf "$BUILD_DIR"; mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

emcmake cmake "$LLVM_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="clang;lld" \
    -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
    -DLLVM_ENABLE_PLUGINS=OFF \
    -DLLVM_ENABLE_BINDINGS=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF \
    -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_RUNTIMES="" \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_DOCS=OFF \
    -DLLVM_TOOL_CLANG_BUILD=ON \
    -DLLVM_TOOL_LLD_BUILD=ON \
    -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
    -DCLANG_ENABLE_ARCMT=OFF \
    -DCLANG_ENABLE_OBJC=OFF \
    -DCLANG_BUILD_EXAMPLES=OFF \
    -DCLANG_ENABLE_UNWINDER=OFF \
    -DLLVM_USE_LINKER=lld \
    2>&1 | tee configure.log

# ── 4. Собираем только clang + lld ─────────────────────────────────────────
echo "→ make clang lld"
emmake make clang lld -j"$JOBS" 2>&1 | tee build.log

# ── 5. Результат ───────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
# Emscripten не даёт одиночных .wasm-бинарей: фактически это .js+wasm.
# Собранные shell-скрипты/файлы выглядят так:
find . -maxdepth 3 \( -name "clang.wasm" -o -name "clang.js" -o -name "clang" \
      -o -name "lld.wasm" -o -name "lld.js" -o -name "lld" \) 2>/dev/null | head -20 \
      | tee "$OUT_DIR/artifacts-list.txt" || true

cp -f "$LLVM_SRC/build"/*/*.wasm "$OUT_DIR/" 2>/dev/null || true
echo "═══ ГОТОВО. Артефакты: $OUT_DIR ═══"
ls -la "$OUT_DIR" 2>/dev/null || echo "(см. artifacts-list.txt)"
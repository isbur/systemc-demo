#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Локальная сборка clang.wasm + lld.wasm (LLVM → WASM через Emscripten)
#  Все найденные флаги уже включены.
#  Запуск: bash build-local-clang-wasm.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$PWD"
BUILD="$ROOT/build-llvm-wasm"
SRC="$ROOT/llvm-src"
JOBS="${JOBS:-$(nproc)}"
MAX_LINK_JOBS="${MAX_LINK_JOBS:-2}"  # для ограничения RAM на линковке

export PATH="$PWD/.pixi/envs/default/bin:$PATH"

echo "→ JOBS=$JOBS, LINK_JOBS=$MAX_LINK_JOBS"

# ── 1. Скачать LLVM исходники ────────────────────────────────────────────
if [ ! -d "$SRC/.git" ]; then
  echo "→ Скачивание LLVM через GitHub..."
  rm -rf "$SRC"
  git clone --depth 1 https://github.com/llvm/llvm-project.git "$SRC" 2>&1 | tail -5 || {
    echo "git clone failed, пробую curl tarball..."
    curl -sL -o llvm-tmp.tar.gz "https://github.com/llvm/llvm-project/archive/refs/heads/main.tar.gz"
    mkdir -p "$SRC" && tar -xzf llvm-tmp.tar.gz -C "$(dirname "$SRC")" && mv llvm-project-main "$SRC" 2>/dev/null || mv llvm-project-* "$SRC"
    rm -f llvm-tmp.tar.gz
  }
  ls "$SRC/llvm/CMakeLists.txt" >/dev/null
fi

# ── 2. Настройка (cmake configure) ────────────────────────────────────────
rm -rf "$BUILD"; mkdir -p "$BUILD"; cd "$BUILD"

echo "→ CMake configure..."
emcmake cmake "$SRC/llvm" \
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
  -DLLVM_TOOL_LTO_BUILD=OFF \
  -DCLANG_BUILD_CLANG_DYLIB=OFF \
  -DCLANG_LINK_CLANG_DYLIB=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_OBJC=OFF \
  -DCLANG_BUILD_EXAMPLES=OFF \
  -DCLANG_ENABLE_UNWINDER=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLVM_ENABLE_LIBCXX=ON \
  -DHAVE_CXX_ATOMICS_WITHOUT_LIB=ON \
  -DHAVE_CXX_ATOMICS64_WITHOUT_LIB=ON \
  -DLLVM_LIBATOMIC_LIBRARY="" \
  -DCMAKE_CXX_COMPILER_WORKS=TRUE \
  -DCMAKE_C_COMPILER_WORKS=TRUE \
  -DLLVM_PARALLEL_LINK_JOBS="$MAX_LINK_JOBS" \
  2>&1 | tail -10

if [ "$?" -ne 0 ]; then
  echo "✖ CMake configure failed"; exit 1
fi

# ── 3. Сборка ─────────────────────────────────────────────────────────────
echo "→ emmake make clang lld (JOBS=$JOBS, LINK_JOBS=$MAX_LINK_JOBS)..."
emmake make clang lld -j"$JOBS" 2>&1 | tail -20

echo "═══════════════════════════════════════════════════"
echo "  Сборка завершена! (проверьте ошибки выше)"
echo "  WASM-файлы:"
find . -name "*.wasm" -type f 2>/dev/null
echo "═"
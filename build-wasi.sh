#!/usr/bin/env bash
# Пересборка libsystemc.a для wasm32-wasi (браузерный компилятор)
set -euo pipefail
cd "$(dirname "$0")"

PIXI_BIN=".pixi/envs/default/bin"
export PATH="$PWD/$PIXI_BIN:$PATH"

echo "=== 1/5: Скачиваем WASI sysroot ==="
mkdir -p .tmp-wasi
curl -s -o .tmp-wasi/sysroot.tar "https://cdn.jsdelivr.net/npm/wasm-clang@0.0.1/bin/sysroot.tar"
rm -rf wasi-sysroot && mkdir -p wasi-sysroot
tar -xf .tmp-wasi/sysroot.tar -C wasi-sysroot

echo "=== 2/5: Кладём pthread-заглушку ==="
cat > wasi-sysroot/include/pthread.h << 'PTHREADEOF'
#ifndef _PTHREAD_H_WASI_STUB
#define _PTHREAD_H_WASI_STUB
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef int pthread_t;
typedef int pthread_mutex_t;
typedef int pthread_cond_t;
typedef int pthread_key_t;
typedef int pthread_once_t;
typedef int pthread_attr_t;
typedef int pthread_mutexattr_t;
typedef int pthread_condattr_t;
#define PTHREAD_MUTEX_INITIALIZER 0
#define PTHREAD_ONCE_INIT 0
#define PTHREAD_CREATE_DETACHED 1
#define PTHREAD_CREATE_JOINABLE 0
static inline int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a) { (void)m; (void)a; return 0; }
static inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { (void)c; (void)m; return 0; }
static inline int pthread_cond_signal(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_cond_broadcast(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*f)(void*), void *d) { (void)t; (void)a; (void)f; (void)d; return 0; }
static inline int pthread_join(pthread_t t, void **r) { (void)t; (void)r; return 0; }
static inline pthread_t pthread_self(void) { return 0; }
static inline int pthread_attr_init(pthread_attr_t *a) { (void)a; return 0; }
static inline int pthread_attr_destroy(pthread_attr_t *a) { (void)a; return 0; }
static inline int pthread_attr_setdetachstate(pthread_attr_t *a, int s) { (void)a; (void)s; return 0; }
static inline int pthread_attr_setstacksize(pthread_attr_t *a, size_t s) { (void)a; (void)s; return 0; }
static inline int pthread_once(pthread_once_t *o, void (*f)(void)) { if (*o == 0) { f(); *o = 1; } return 0; }
static inline int pthread_key_create(pthread_key_t *k, void (*d)(void*)) { (void)k; (void)d; return 0; }
static inline void *pthread_getspecific(pthread_key_t k) { (void)k; return NULL; }
static inline int pthread_setspecific(pthread_key_t k, const void *v) { (void)k; (void)v; return 0; }
#ifdef __cplusplus
}
#endif
#endif
PTHREADEOF

echo "=== 3/5: Патчим корутинную заглушку SystemC ==="
rm -rf build-wasi-src
cp -r systemc-src build-wasi-src
cat > build-wasi-src/src/sysc/kernel/sc_cor_pthread.cpp << 'SCEOF'
// Stub for WASI — no real pthreads coroutine support.
#include "sysc/kernel/sc_cor_pthread.h"

namespace sc_core {

sc_cor_pthread::sc_cor_pthread()
    : sc_cor(), m_cor_fn(0), m_cor_fn_arg(0), m_pkg_p(0) {}

sc_cor_pthread::~sc_cor_pthread() {}

void* sc_cor_pthread::invoke_module_method(void* context_p) { return 0; }

sc_cor_pkg_pthread::sc_cor_pkg_pthread(sc_simcontext* simc)
    : sc_cor_pkg(simc), m_main_cor(), m_curr_cor(0) {}

sc_cor_pkg_pthread::~sc_cor_pkg_pthread() {}

sc_cor* sc_cor_pkg_pthread::create(std::size_t stack_size, sc_cor_fn* fn, void* arg) { return 0; }
void sc_cor_pkg_pthread::yield(sc_cor* next_cor) {}
void sc_cor_pkg_pthread::abort(sc_cor* next_cor) {}
sc_cor* sc_cor_pkg_pthread::get_main() { return &m_main_cor; }

} // namespace sc_core
SCEOF

echo "=== 4/5: CMake + make ==="
rm -rf build-wasi
mkdir -p build-wasi && cd build-wasi
cmake ../build-wasi-src \
  -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_STANDARD=17 \
  -DCMAKE_SYSROOT="$PWD/../wasi-sysroot" \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_C_FLAGS="--target=wasm32-wasi" -DCMAKE_CXX_FLAGS="--target=wasm32-wasi -fno-threadsafe-statics" \
  -DENABLE_PTHREADS=OFF -DENABLE_STD_THREADS=OFF \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DENABLE_EXAMPLES=OFF -DENABLE_REGRESSION=OFF -DDISABLE_COPYRIGHT_MESSAGE=ON
make -j"$(nproc)"
cd ..

echo "=== 5/5: Собираем systemc-bundle.tar ==="
rm -rf app/wasi-systemc-build
mkdir -p app/wasi-systemc-build/lib/wasm32-wasi
cp -r systemc-src/src/sysc     app/wasi-systemc-build/include-sysc 2>/dev/null
mkdir -p app/wasi-systemc-build/include
cp -r systemc-src/src/sysc     app/wasi-systemc-build/include/sysc
cp -r systemc-src/src/tlm      app/wasi-systemc-build/include/tlm 2>/dev/null || true
cp -r systemc-src/src/tlm_core app/wasi-systemc-build/include/tlm_core 2>/dev/null || true
cp -r systemc-src/src/tlm_utils app/wasi-systemc-build/include/tlm_utils 2>/dev/null || true
cp systemc-src/src/systemc.h   app/wasi-systemc-build/include/
cp build-wasi/src/libsystemc.a app/wasi-systemc-build/lib/wasm32-wasi/
cd app/wasi-systemc-build
tar cf ../systemc-bundle.tar include lib
cd ..
rm -rf app/wasi-systemc-build/include-sysc app/wasi-systemc-build
echo "✅ systemc-bundle.tar готов:"
ls -la app/systemc-bundle.tar
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
#endif /* _PTHREAD_H_WASI_STUB */
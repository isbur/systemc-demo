// One SystemC kernel for the whole canvas.
// top.cc (no SystemC headers) calls the C API. Module factories are separate objects.
#include "systemc.h"

#include <cstddef>
#include <iostream>
#include <vector>

namespace {

constexpr int kDeltaLimit = 10000;

std::vector<sc_core::sc_signal<bool>*> g_signals;
std::vector<int> g_sample;
int g_period_ns = 10;
bool g_built = false;
bool g_overflow = false;
bool g_stopped = false;
int g_max_deltas = 0;

struct DeltaGuard : sc_core::sc_module {
  sc_core::sc_time stamp;
  bool have = false;
  int streak = 0;

  SC_HAS_PROCESS(DeltaGuard);
  explicit DeltaGuard(sc_core::sc_module_name nm)
      : sc_core::sc_module(nm), stamp(sc_core::SC_ZERO_TIME) {
    SC_METHOD(watch);
    for (sc_core::sc_signal<bool>* signal : g_signals) sensitive << *signal;
    dont_initialize();
  }

  // Release builds do not enforce SC_MAX_NUM_DELTA_CYCLES (DEBUG_SYSTEMC only).
  // A zero-delay loop would otherwise never return from sc_start.
  void watch() {
    const sc_core::sc_time now = sc_core::sc_time_stamp();
    if (!have || now != stamp) {
      have = true;
      stamp = now;
      streak = 1;
    } else {
      streak++;
    }
    if (streak > g_max_deltas) g_max_deltas = streak;
    if (streak > kDeltaLimit) {
      g_overflow = true;
      std::cout << "delta-cycle limit exceeded (" << kDeltaLimit << ")\n";
      sc_core::sc_stop();
    }
  }
};

DeltaGuard* g_guard = nullptr;

void note_stop() {
  if (g_overflow || sc_core::sc_get_status() == sc_core::SC_STOPPED) g_stopped = true;
}

// sc_start(SC_ZERO_TIME) performs exactly one delta (crunch once).
// Combinational logic needs the deltas that follow, so drain them explicitly.
void settle_deltas() {
  sc_core::sc_start(sc_core::SC_ZERO_TIME);
  note_stop();
  int spins = 0;
  while (!g_overflow && !g_stopped && sc_core::sc_pending_activity_at_current_time()) {
    sc_core::sc_start(sc_core::SC_ZERO_TIME);
    note_stop();
    if (++spins > kDeltaLimit + 8) {
      g_overflow = true;
      g_stopped = true;
      break;
    }
  }
}

}  // namespace

extern "C" void circuit_build();

extern "C" {

int circuit_status();

void rt_configure(int period_ns) {
  if (period_ns > 0) g_period_ns = period_ns;
}

int rt_add_bool(const char* name) {
  g_signals.push_back(new sc_core::sc_signal<bool>(name));
  return static_cast<int>(g_signals.size()) - 1;
}

int rt_add_clock(const char* name) {
  const double period = static_cast<double>(g_period_ns);
  const double start = period / 2.0;
  // Rising edge at half period: one UI step is one edge, clock stays low after init.
  auto* clock = new sc_core::sc_clock(
      name, period, sc_core::SC_NS, 0.5, start, sc_core::SC_NS, true);
  g_signals.push_back(clock);
  return static_cast<int>(g_signals.size()) - 1;
}

void* rt_ptr(int id) {
  return g_signals.at(static_cast<size_t>(id));
}

int circuit_init() {
  if (g_built) return circuit_status();
  circuit_build();
  g_guard = new DeltaGuard("canvas_delta_guard");
  g_built = true;
  try {
    settle_deltas();
  } catch (const sc_core::sc_report& report) {
    std::cout << report.what() << '\n';
    g_stopped = true;
  }
  return circuit_status();
}

int circuit_step() {
  if (!g_built) circuit_init();
  if (g_stopped) return circuit_status();
  try {
    sc_core::sc_start(static_cast<double>(g_period_ns) / 2.0, sc_core::SC_NS);
    note_stop();
    while (!g_overflow && !g_stopped && sc_core::sc_pending_activity_at_current_time()) {
      sc_core::sc_start(sc_core::SC_ZERO_TIME);
      note_stop();
    }
  } catch (const sc_core::sc_report& report) {
    std::cout << report.what() << '\n';
    g_stopped = true;
  }
  return circuit_status();
}

int circuit_sample() {
  g_sample.resize(g_signals.size());
  for (size_t i = 0; i < g_signals.size(); i++) {
    g_sample[i] = g_signals[i]->read() ? 1 : 0;
  }
  return static_cast<int>(g_sample.size());
}

int* circuit_sample_ptr() {
  return g_sample.empty() ? nullptr : g_sample.data();
}

long long circuit_time_ps() {
  return static_cast<long long>(sc_core::sc_time_stamp().value());
}

int circuit_status() {
  if (g_overflow) return 1;
  if (g_stopped) return 2;
  return 0;
}

int circuit_deltas() { return g_max_deltas; }

int sc_main(int, char*[]) { return 0; }

}

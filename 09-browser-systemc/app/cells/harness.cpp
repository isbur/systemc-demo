// Общий экземпляр ядра на один элемент канвы.
// Номера типов совпадают с cellType в app/elements.js.
#include "systemc.h"
#include "clock.cpp"
#include "vcc.cpp"
#include "gnd.cpp"
#include "and.cpp"
#include "or.cpp"
#include "not.cpp"
#include "nand.cpp"
#include "nor.cpp"
#include "xor.cpp"
#include "dff.cpp"
#include "ring4.cpp"
#include "counter4.cpp"
#include "mux2.cpp"
#include "mux4.cpp"
#include "half_adder.cpp"

enum {
  CELL_CLOCK = 1,
  CELL_VCC,
  CELL_GND,
  CELL_AND,
  CELL_OR,
  CELL_NOT,
  CELL_NAND,
  CELL_NOR,
  CELL_XOR,
  CELL_DFF,
  CELL_RING4,
  CELL_COUNTER4,
  CELL_MUX2,
  CELL_MUX4,
  CELL_HALF_ADDER
};

struct Host {
  int nin = 0;
  int nout = 0;
  sc_signal<bool>* ins[6]{};
  sc_signal<bool>* outs[4]{};
  virtual ~Host() {}
  virtual void step() { settle(); }
  virtual void reset() {}
  void set_in(int i, int v) {
    if (i >= 0 && i < nin && ins[i]) ins[i]->write(v != 0);
  }
  int get_out(int i) const {
    if (i < 0 || i >= nout || !outs[i]) return 0;
    return outs[i]->read() ? 1 : 0;
  }
  // sc_start(0) делает один дельта-цикл и выходит, когда метод
  // только поставлен в очередь обновлением входа. Крутим, пока очередь не пуста.
  void settle() {
    for (int i = 0; i < 16; i++) {
      if (!sc_pending_activity_at_current_time()) return;
      sc_start(SC_ZERO_TIME);
    }
  }
};

struct ClockHost : Host {
  sc_signal<bool> clk;
  Clock* m;
  ClockHost() : m(new Clock("clock")) {
    m->clk(clk);
    outs[0] = &clk;
    nout = 1;
  }
  void step() override {
    m->step.notify(SC_ZERO_TIME);
    settle();
  }
  void reset() override {
    m->phase = false;
    clk.write(false);
    settle();
  }
};

struct VccHost : Host {
  sc_signal<bool> y;
  VccHost() {
    Vcc* m = new Vcc("vcc");
    m->y(y);
    outs[0] = &y;
    nout = 1;
  }
};

struct GndHost : Host {
  sc_signal<bool> y;
  GndHost() {
    Gnd* m = new Gnd("gnd");
    m->y(y);
    outs[0] = &y;
    nout = 1;
  }
};

struct AndHost : Host {
  sc_signal<bool> a, b, y;
  AndHost() {
    And* m = new And("and");
    m->a(a); m->b(b); m->y(y);
    ins[0] = &a; ins[1] = &b; nin = 2;
    outs[0] = &y; nout = 1;
  }
};

struct OrHost : Host {
  sc_signal<bool> a, b, y;
  OrHost() {
    Or* m = new Or("or");
    m->a(a); m->b(b); m->y(y);
    ins[0] = &a; ins[1] = &b; nin = 2;
    outs[0] = &y; nout = 1;
  }
};

struct NotHost : Host {
  sc_signal<bool> a, y;
  NotHost() {
    Not* m = new Not("not");
    m->a(a); m->y(y);
    ins[0] = &a; nin = 1;
    outs[0] = &y; nout = 1;
  }
};

struct NandHost : Host {
  sc_signal<bool> a, b, y;
  NandHost() {
    Nand* m = new Nand("nand");
    m->a(a); m->b(b); m->y(y);
    ins[0] = &a; ins[1] = &b; nin = 2;
    outs[0] = &y; nout = 1;
  }
};

struct NorHost : Host {
  sc_signal<bool> a, b, y;
  NorHost() {
    Nor* m = new Nor("nor");
    m->a(a); m->b(b); m->y(y);
    ins[0] = &a; ins[1] = &b; nin = 2;
    outs[0] = &y; nout = 1;
  }
};

struct XorHost : Host {
  sc_signal<bool> a, b, y;
  XorHost() {
    Xor* m = new Xor("xor");
    m->a(a); m->b(b); m->y(y);
    ins[0] = &a; ins[1] = &b; nin = 2;
    outs[0] = &y; nout = 1;
  }
};

struct DffHost : Host {
  sc_signal<bool> clk, d, rst_n, q, qn;
  Dff* m;
  DffHost() : m(new Dff("dff")) {
    m->clk(clk); m->d(d); m->rst_n(rst_n); m->q(q); m->qn(qn);
    ins[0] = &clk; ins[1] = &d; ins[2] = &rst_n; nin = 3;
    outs[0] = &q; outs[1] = &qn; nout = 2;
  }
  void reset() override {
    m->reset_state();
    settle();
  }
};

struct RingHost : Host {
  sc_signal<bool> clk, rst_n, enable, q0, q1, q2, q3;
  Ring4* m;
  RingHost() : m(new Ring4("ring")) {
    m->clk(clk); m->rst_n(rst_n); m->enable(enable);
    m->q0(q0); m->q1(q1); m->q2(q2); m->q3(q3);
    ins[0] = &clk; ins[1] = &rst_n; ins[2] = &enable; nin = 3;
    outs[0] = &q0; outs[1] = &q1; outs[2] = &q2; outs[3] = &q3; nout = 4;
  }
  void reset() override {
    m->reset_state();
    settle();
  }
};

struct CounterHost : Host {
  sc_signal<bool> clk, rst_n, enable, q0, q1, q2, q3;
  Counter4* m;
  CounterHost() : m(new Counter4("counter")) {
    m->clk(clk); m->rst_n(rst_n); m->enable(enable);
    m->q0(q0); m->q1(q1); m->q2(q2); m->q3(q3);
    ins[0] = &clk; ins[1] = &rst_n; ins[2] = &enable; nin = 3;
    outs[0] = &q0; outs[1] = &q1; outs[2] = &q2; outs[3] = &q3; nout = 4;
  }
  void reset() override {
    m->reset_state();
    settle();
  }
};

struct Mux2Host : Host {
  sc_signal<bool> sel, a, b, y;
  Mux2Host() {
    Mux2* m = new Mux2("mux2");
    m->sel(sel); m->a(a); m->b(b); m->y(y);
    ins[0] = &sel; ins[1] = &a; ins[2] = &b; nin = 3;
    outs[0] = &y; nout = 1;
  }
};

struct Mux4Host : Host {
  sc_signal<bool> s0, s1, a, b, c, d, y;
  Mux4Host() {
    Mux4* m = new Mux4("mux4");
    m->s0(s0); m->s1(s1); m->a(a); m->b(b); m->c(c); m->d(d); m->y(y);
    ins[0] = &s0; ins[1] = &s1; ins[2] = &a; ins[3] = &b; ins[4] = &c; ins[5] = &d;
    nin = 6;
    outs[0] = &y; nout = 1;
  }
};

struct HalfHost : Host {
  sc_signal<bool> a, b, sum, carry;
  HalfHost() {
    HalfAdder* m = new HalfAdder("half");
    m->a(a); m->b(b); m->sum(sum); m->carry(carry);
    ins[0] = &a; ins[1] = &b; nin = 2;
    outs[0] = &sum; outs[1] = &carry; nout = 2;
  }
};

static Host* host = nullptr;

static Host* make_host(int type) {
  switch (type) {
    case CELL_CLOCK: return new ClockHost();
    case CELL_VCC: return new VccHost();
    case CELL_GND: return new GndHost();
    case CELL_AND: return new AndHost();
    case CELL_OR: return new OrHost();
    case CELL_NOT: return new NotHost();
    case CELL_NAND: return new NandHost();
    case CELL_NOR: return new NorHost();
    case CELL_XOR: return new XorHost();
    case CELL_DFF: return new DffHost();
    case CELL_RING4: return new RingHost();
    case CELL_COUNTER4: return new CounterHost();
    case CELL_MUX2: return new Mux2Host();
    case CELL_MUX4: return new Mux4Host();
    case CELL_HALF_ADDER: return new HalfHost();
    default: return nullptr;
  }
}

int sc_main(int, char*[]) { return 0; }

extern "C" {

void cell_init(int type) {
  if (host) return;
  host = make_host(type);
  if (!host) return;
  sc_start(SC_ZERO_TIME);
  host->settle();
}

void cell_set(int pin, int value) {
  if (host) host->set_in(pin, value);
}

void cell_eval() {
  if (host) host->step();
}

int cell_get(int pin) {
  return host ? host->get_out(pin) : 0;
}

void cell_reset() {
  if (host) host->reset();
}

}

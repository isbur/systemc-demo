#include "systemc.h"

SC_MODULE(Mux4) {
  sc_in<bool> s0;
  sc_in<bool> s1;
  sc_in<bool> a;
  sc_in<bool> b;
  sc_in<bool> c;
  sc_in<bool> d;
  sc_out<bool> y;

  void eval() {
    int sel = (s1.read() ? 2 : 0) | (s0.read() ? 1 : 0);
    bool v = a.read();
    if (sel == 1) v = b.read();
    else if (sel == 2) v = c.read();
    else if (sel == 3) v = d.read();
    y.write(v);
  }

  SC_CTOR(Mux4) {
    SC_METHOD(eval);
    sensitive << s0 << s1 << a << b << c << d;
  }
};

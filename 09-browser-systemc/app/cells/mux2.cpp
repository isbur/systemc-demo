#include "systemc.h"

SC_MODULE(Mux2) {
  sc_in<bool> sel;
  sc_in<bool> a;
  sc_in<bool> b;
  sc_out<bool> y;

  void eval() { y.write(sel.read() ? b.read() : a.read()); }

  SC_CTOR(Mux2) {
    SC_METHOD(eval);
    sensitive << sel << a << b;
  }
};

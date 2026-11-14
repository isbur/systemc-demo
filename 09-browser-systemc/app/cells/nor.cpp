#include "systemc.h"

SC_MODULE(Nor) {
  sc_in<bool> a;
  sc_in<bool> b;
  sc_out<bool> y;

  void eval() { y.write(!(a.read() || b.read())); }

  SC_CTOR(Nor) {
    SC_METHOD(eval);
    sensitive << a << b;
  }
};

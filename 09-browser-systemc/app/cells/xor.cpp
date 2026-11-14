#include "systemc.h"

SC_MODULE(Xor) {
  sc_in<bool> a;
  sc_in<bool> b;
  sc_out<bool> y;

  void eval() { y.write(a.read() != b.read()); }

  SC_CTOR(Xor) {
    SC_METHOD(eval);
    sensitive << a << b;
  }
};

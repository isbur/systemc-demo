#include "systemc.h"

SC_MODULE(HalfAdder) {
  sc_in<bool> a;
  sc_in<bool> b;
  sc_out<bool> sum;
  sc_out<bool> carry;

  void eval() {
    sum.write(a.read() != b.read());
    carry.write(a.read() && b.read());
  }

  SC_CTOR(HalfAdder) {
    SC_METHOD(eval);
    sensitive << a << b;
  }
};

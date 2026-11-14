#include "systemc.h"

SC_MODULE(Not) {
  sc_in<bool> a;
  sc_out<bool> y;

  void eval() { y.write(!a.read()); }

  SC_CTOR(Not) {
    SC_METHOD(eval);
    sensitive << a;
  }
};

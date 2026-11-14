#include "systemc.h"

SC_MODULE(Vcc) {
  sc_out<bool> y;

  void drive() { y.write(true); }

  SC_CTOR(Vcc) {
    SC_METHOD(drive);
  }
};

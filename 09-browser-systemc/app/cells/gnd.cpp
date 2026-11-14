#include "systemc.h"

SC_MODULE(Gnd) {
  sc_out<bool> y;

  void drive() { y.write(false); }

  SC_CTOR(Gnd) {
    SC_METHOD(drive);
  }
};

// Сброс — по спаду rst_n, запись d — по фронту clk. Уровень rst_n сам по себе q не держит.
#include "systemc.h"

SC_MODULE(Dff) {
  sc_in<bool> clk;
  sc_in<bool> d;
  sc_in<bool> rst_n;
  sc_out<bool> q;
  sc_out<bool> qn;
  bool qval = false;

  void eval() {
    if (rst_n.negedge()) qval = false;
    else if (clk.posedge()) qval = d.read();
    q.write(qval);
    qn.write(!qval);
  }

  void reset_state() {
    qval = false;
    q.write(false);
    qn.write(true);
  }

  SC_CTOR(Dff) {
    SC_METHOD(eval);
    sensitive << clk << rst_n;
  }
};

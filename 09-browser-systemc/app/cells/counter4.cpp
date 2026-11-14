// Счётчик 0..15. +1 на фронте clk при enable = 1, ноль по спаду rst_n.
#include "systemc.h"

SC_MODULE(Counter4) {
  sc_in<bool> clk;
  sc_in<bool> rst_n;
  sc_in<bool> enable;
  sc_out<bool> q0;
  sc_out<bool> q1;
  sc_out<bool> q2;
  sc_out<bool> q3;
  sc_uint<4> val = 0;

  void write_q() {
    q0.write(val[0]);
    q1.write(val[1]);
    q2.write(val[2]);
    q3.write(val[3]);
  }

  void eval() {
    if (rst_n.negedge()) val = 0;
    else if (clk.posedge() && enable.read()) val = val + 1;
    write_q();
  }

  void reset_state() {
    val = 0;
    write_q();
  }

  SC_CTOR(Counter4) {
    SC_METHOD(eval);
    sensitive << clk << rst_n;
  }
};

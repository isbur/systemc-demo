// Кольцо 0001. Сдвиг на фронте clk при enable = 1, возврат к 0001 по спаду rst_n.
#include "systemc.h"

SC_MODULE(Ring4) {
  sc_in<bool> clk;
  sc_in<bool> rst_n;
  sc_in<bool> enable;
  sc_out<bool> q0;
  sc_out<bool> q1;
  sc_out<bool> q2;
  sc_out<bool> q3;
  sc_uint<4> reg = 1;

  void write_q() {
    q0.write(reg[0]);
    q1.write(reg[1]);
    q2.write(reg[2]);
    q3.write(reg[3]);
  }

  void eval() {
    if (rst_n.negedge()) reg = 1;
    else if (clk.posedge() && enable.read()) {
      bool msb = reg[3];
      reg = reg << 1;
      reg[0] = msb;
    }
    write_q();
  }

  void reset_state() {
    reg = 1;
    write_q();
  }

  SC_CTOR(Ring4) {
    SC_METHOD(eval);
    sensitive << clk << rst_n;
  }
};

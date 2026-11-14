#ifndef RING_COUNTER_H
#define RING_COUNTER_H

#include <systemc.h>

/**
 * Ring Counter Module
 *
 * A parameterized N-bit ring counter. On reset, the LSB is set to 1 and all
 * other bits are 0. On each rising clock edge (with enable), the 1-bit
 * circulates left: the MSB wraps around to the LSB position.
 */
SC_MODULE(ring_counter) {
    // --- Ports ---
    sc_in<bool>  clk;      // Clock input
    sc_in<bool>  rst_n;    // Asynchronous active-low reset
    sc_in<bool>  enable;   // Enable signal
    sc_out<sc_uint<4>> q;  // 4-bit output

    // --- Internal data ---
    sc_uint<4> shift_reg;

    // --- Processes ---
    void shift_proc() {
        if (!rst_n.read()) {
            shift_reg = 1;  // 0b0001 — seed the ring with a single '1'
        } else if (enable.read()) {
            // Rotate left: MSB wraps around to LSB
            bool msb = shift_reg[3];
            shift_reg = shift_reg << 1;
            shift_reg[0] = msb;
        }
        q.write(shift_reg);
    }

    // --- Constructor ---
    SC_CTOR(ring_counter) {
        SC_METHOD(shift_proc);
        sensitive << clk.pos();
        sensitive << rst_n.neg();
    }
};

#endif // RING_COUNTER_H
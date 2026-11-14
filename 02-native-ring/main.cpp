#include "tb_ring_counter.h"

int sc_main(int argc, char* argv[]) {
    // Instantiate the testbench
    tb_ring_counter tb("tb");

    // Configure traces
    sc_trace_file* tf = sc_create_vcd_trace_file("ring_counter");
    sc_trace(tf, tb.clk,   "clk");
    sc_trace(tf, tb.rst_n, "rst_n");
    sc_trace(tf, tb.enable,"enable");
    sc_trace(tf, tb.q,     "q");

    std::cout << "\n=== Ring Counter Simulation ===" << std::endl;
    std::cout << "Time         rst_n en  q    (binary)" << std::endl;
    std::cout << "-----------------------------------" << std::endl;

    // Run simulation for 150 ns max
    sc_start(150, SC_NS);

    // Close trace file
    sc_close_vcd_trace_file(tf);

    std::cout << "=================================" << std::endl;
    std::cout << "Simulation completed. VCD trace written to ring_counter.vcd" << std::endl;

    return 0;
}
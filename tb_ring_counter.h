#include "ring_counter.h"

/**
 * Testbench for the ring counter.
 * Generates clock, reset, and enable stimuli, and prints the output.
 */
SC_MODULE(tb_ring_counter) {
    // --- Signals (bound to DUT) ---
    sc_signal<bool>         clk;
    sc_signal<bool>         rst_n;
    sc_signal<bool>         enable;
    sc_signal<sc_uint<4>>   q;

    // --- Instance of the ring counter ---
    ring_counter* dut;

    // --- Clock generator ---
    void clk_gen() {
        while (true) {
            clk = !clk;
            wait(5, SC_NS);   // 10 ns period → 100 MHz
        }
    }

    // --- Stimulus sequence ---
    void stimulus() {
        // Initial state: reset asserted
        rst_n = 0;
        enable = 0;
        wait(15, SC_NS);

        // De-assert reset; enable after 1 clock
        rst_n = 1;
        wait(10, SC_NS);

        // Run the ring counter for 12 cycles
        for (int i = 0; i < 12; i++) {
            enable = 1;
            wait(10, SC_NS);  // one full clock cycle
        }

        // Stop the simulation
        sc_stop();
    }

    // --- Monitor: print output on every positive clock edge ---
    void monitor() {
        while (true) {
            wait(clk.posedge_event());
            std::cout << sc_time_stamp()
                      << "  rst_n=" << rst_n.read()
                      << "  en=" << enable.read()
                      << "  q=" << q.read()
                      << "  (0b" << q.read().to_string(SC_BIN) << ")"
                      << std::endl;
        }
    }

    // --- Constructor ---
    SC_CTOR(tb_ring_counter) {
        dut = new ring_counter("dut");
        dut->clk(clk);
        dut->rst_n(rst_n);
        dut->enable(enable);
        dut->q(q);

        SC_THREAD(clk_gen);
        SC_THREAD(stimulus);

        SC_THREAD(monitor);
    }

    ~tb_ring_counter() {
        delete dut;
    }
};
#include <systemc.h>
#include <cstdint>

// --- Module: Ring Counter (same logic as before) ---
SC_MODULE(ring_counter) {
    sc_in<bool>         clk;
    sc_in<bool>         rst_n;
    sc_in<bool>         enable;
    sc_out<sc_uint<4>>  q;

    sc_uint<4> shift_reg;

    void shift_proc() {
        if (!rst_n.read()) {
            shift_reg = 1;
        } else if (enable.read()) {
            bool msb = shift_reg[3];
            shift_reg = shift_reg << 1;
            shift_reg[0] = msb;
        }
        q.write(shift_reg);
    }

    SC_CTOR(ring_counter) {
        SC_METHOD(shift_proc);
        sensitive << clk.pos();
        sensitive << rst_n.neg();
    }
};

// --- Globals ---
static ring_counter*   dut     = nullptr;
static sc_signal<bool> clk_sig;
static sc_signal<bool> rst_n_sig;
static sc_signal<bool> enable_sig;
static sc_signal<sc_uint<4>> q_sig;

// --- Exported C functions (callable from JavaScript) ---

extern "C" {

void init() {
    // Prevent double init
    if (dut) return;

    dut = new ring_counter("dut");
    dut->clk(clk_sig);
    dut->rst_n(rst_n_sig);
    dut->enable(enable_sig);
    dut->q(q_sig);

    // Initial state: reset asserted, clock low, disabled
    clk_sig   = false;
    rst_n_sig = false;
    enable_sig = false;

    // Initialize the SystemC kernel (don't run yet)
    sc_start(sc_core::SC_ZERO_TIME);
}

void reset_ring() {
    rst_n_sig = false;
    // Advance delta cycles to let reset propagate
    sc_start(sc_core::SC_ZERO_TIME);
    rst_n_sig = true;
    sc_start(sc_core::SC_ZERO_TIME);
}

int32_t step() {
    // Toggle clock low -> high (positive edge)
    enable_sig = true;
    clk_sig = true;
    sc_start(sc_core::SC_ZERO_TIME);

    int32_t val = static_cast<int32_t>(q_sig.read().to_int());

    // Toggle clock high -> low
    clk_sig = false;
    sc_start(sc_core::SC_ZERO_TIME);

    return val;
}

int32_t get_q() {
    return static_cast<int32_t>(q_sig.read().to_int());
}

void set_enable(int32_t en) {
    enable_sig = (en != 0);
}

} // extern "C"

// sc_main is called by the SystemC kernel runtime (via the main() wrapper in libsystemc).
// We just set up the module. The JS driver calls init/step/reset_ring directly later.
// sc_main must exist for the linker, but we don't actually use it in interactive mode.
int sc_main(int argc, char* argv[]) {
    // Not reached in interactive mode — init() is called from JS.
    return 0;
}
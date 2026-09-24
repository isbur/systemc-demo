#include "systemc.h"

#include "sysc/communication/sc_clock.cpp"
#include "sysc/communication/sc_event_finder.cpp"
#include "sysc/communication/sc_event_queue.cpp"
#include "sysc/communication/sc_export.cpp"
#include "sysc/communication/sc_interface.cpp"
#include "sysc/communication/sc_mutex.cpp"
#include "sysc/communication/sc_port.cpp"
#include "sysc/communication/sc_prim_channel.cpp"
#include "sysc/communication/sc_semaphore.cpp"
#include "sysc/communication/sc_signal.cpp"
#include "sysc/communication/sc_signal_ports.cpp"
#include "sysc/communication/sc_signal_resolved.cpp"
#include "sysc/communication/sc_signal_resolved_ports.cpp"
#include "sysc/datatypes/bit/sc_bit.cpp"
#include "sysc/datatypes/bit/sc_bv_base.cpp"
#include "sysc/datatypes/bit/sc_logic.cpp"
#include "sysc/datatypes/bit/sc_lv_base.cpp"
#include "sysc/datatypes/fx/sc_fxcast_switch.cpp"
#include "sysc/datatypes/fx/sc_fxdefs.cpp"
#include "sysc/datatypes/fx/sc_fxnum.cpp"
#include "sysc/datatypes/fx/sc_fxnum_observer.cpp"
#include "sysc/datatypes/fx/sc_fxtype_params.cpp"
#include "sysc/datatypes/fx/sc_fxval.cpp"
#include "sysc/datatypes/fx/sc_fxval_observer.cpp"
#include "sysc/datatypes/fx/scfx_mant.cpp"
#include "sysc/datatypes/fx/scfx_pow10.cpp"
#include "sysc/datatypes/fx/scfx_rep.cpp"
#include "sysc/datatypes/fx/scfx_utils.cpp"
#include "sysc/datatypes/int/sc_int32_mask.cpp"
#include "sysc/datatypes/int/sc_int64_io.cpp"
#include "sysc/datatypes/int/sc_int64_mask.cpp"
#include "sysc/datatypes/int/sc_int_base.cpp"
#include "sysc/datatypes/int/sc_length_param.cpp"
#include "sysc/datatypes/int/sc_nbutils.cpp"
#include "sysc/datatypes/int/sc_signed.cpp"
#include "sysc/datatypes/int/sc_uint_base.cpp"
#include "sysc/datatypes/int/sc_unsigned.cpp"
#include "sysc/datatypes/misc/sc_value_base.cpp"
#include "sysc/kernel/sc_attribute.cpp"
#include "sysc/kernel/sc_cor_fiber.cpp"
#include "sysc/kernel/sc_cor_pthread.cpp"
#include "sysc/kernel/sc_cor_qt.cpp"
#include "sysc/kernel/sc_cor_std_thread.cpp"
#include "sysc/kernel/sc_cthread_process.cpp"
#include "sysc/kernel/sc_event.cpp"
#include "sysc/kernel/sc_except.cpp"
#include "sysc/kernel/sc_join.cpp"
#include "sysc/kernel/sc_main.cpp"
#include "sysc/kernel/sc_main_main.cpp"
#include "sysc/kernel/sc_method_process.cpp"
#include "sysc/kernel/sc_module.cpp"
#include "sysc/kernel/sc_module_name.cpp"
#include "sysc/kernel/sc_module_registry.cpp"
#include "sysc/kernel/sc_name_gen.cpp"
#include "sysc/kernel/sc_object.cpp"
#include "sysc/kernel/sc_object_manager.cpp"
#include "sysc/kernel/sc_process.cpp"
#include "sysc/kernel/sc_reset.cpp"
#include "sysc/kernel/sc_sensitive.cpp"
#include "sysc/kernel/sc_simcontext.cpp"
#include "sysc/kernel/sc_spawn_options.cpp"
#include "sysc/kernel/sc_stage_callback_registry.cpp"
#include "sysc/kernel/sc_thread_process.cpp"
#include "sysc/kernel/sc_time.cpp"
#include "sysc/kernel/sc_ver.cpp"
#include "sysc/kernel/sc_wait.cpp"
#include "sysc/kernel/sc_wait_cthread.cpp"
#include "sysc/tracing/sc_trace.cpp"
#include "sysc/tracing/sc_trace_file_base.cpp"
#include "sysc/tracing/sc_vcd_trace.cpp"
#include "sysc/tracing/sc_wif_trace.cpp"
#include "sysc/utils/sc_hash.cpp"
#include "sysc/utils/sc_list.cpp"
#include "sysc/utils/sc_mempool.cpp"
#include "sysc/utils/sc_pq.cpp"
#include "sysc/utils/sc_report.cpp"
#include "sysc/utils/sc_report_handler.cpp"
#include "sysc/utils/sc_stop_here.cpp"
#include "sysc/utils/sc_utils_ids.cpp"
#include "sysc/utils/sc_vector.cpp"
#include "tlm_core/tlm_2/tlm_generic_payload/tlm_gp.cpp"
#include "tlm_core/tlm_2/tlm_generic_payload/tlm_phase.cpp"
#include "tlm_core/tlm_2/tlm_quantum/tlm_global_quantum.cpp"
#include "tlm_utils/convenience_socket_bases.cpp"
#include "tlm_utils/instance_specific_extensions.cpp"

// User code

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
// Тактовый генератор канвы. Редактор на каждом своём шаге уведомляет step,
// и метод переключает clk. Своего sc_clock здесь нет: время ведёт канва.
#include "systemc.h"

SC_MODULE(Clock) {
  sc_out<bool> clk;
  sc_event step;
  bool phase = false;

  void on_step() {
    phase = !phase;
    clk.write(phase);
  }

  SC_CTOR(Clock) {
    SC_METHOD(on_step);
    sensitive << step;
    dont_initialize();
  }
};

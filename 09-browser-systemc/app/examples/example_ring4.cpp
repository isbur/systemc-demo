// ═══════════════════════════════════════════════════════════════════════
//  C++ модуль — 4-битный кольцевой регистр (Ring Counter)
//  Индексы входов:  in0 = clk,  in1 = enable,  in2 = rst_n (активный низкий)
//  Индексы выходов: out0..out3 = биты 0..3 регистра
//  state[0] хранит значение регистра (1,2,4,8,1,2,4,8,…)
// ═══════════════════════════════════════════════════════════════════════

void user_evaluate(int32_t* inputs, int32_t* outputs, int32_t* state) {
    outputs[0] = (state[0] >> 0) & 1;
    outputs[1] = (state[0] >> 1) & 1;
    outputs[2] = (state[0] >> 2) & 1;
    outputs[3] = (state[0] >> 3) & 1;
}

void user_clock_edge(int32_t edge, int32_t* inputs, int32_t* outputs, int32_t* state) {
    if (edge != 1) return;
    if (inputs[2] == 0) {
        state[0] = 0b0001;
    } else if (inputs[1] == 1) {
        int32_t msb = (state[0] >> 3) & 1;
        state[0] = ((state[0] << 1) | msb) & 0xF;
    }
    user_evaluate(inputs, outputs, state);
}

void user_reset(int32_t* state) {
    state[0] = 0b0001;
}

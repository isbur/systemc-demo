import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELL_UNITS, circuitFingerprint, generateCircuit, moduleShape } from './app/netlist.js';
import { GATES } from './app/elements.js';

const appDir = join(dirname(fileURLToPath(import.meta.url)), 'app');
assert.ok(existsSync(join(appDir, 'coi-serviceworker.js')));
assert.ok(existsSync(join(appDir, 'thread.js')), 'pthread worker must sit next to the COI service worker');
assert.match(
  readFileSync(join(appDir, 'sim-host.js'), 'utf8'),
  /new URL\('\.\/thread\.js'/,
);
assert.equal(existsSync(join(dirname(appDir), 'pthread-host', 'thread.js')), false);

assert.equal(moduleShape(`int sc_main(int, char*[]) { return 0; }`).kind, 'autorun');
assert.equal(moduleShape(`int sc_main(int, char*[]) { return 0; }`).className, 'sc_main');

const shape = moduleShape(`
#include "systemc.h"
SC_MODULE(user_module) {
  sc_in<bool> clk;
  sc_in<bool> rst_n;
  sc_in<bool> enable;
  sc_out<sc_uint<4>> q;
  SC_CTOR(user_module) {}
};
`);
assert.equal(shape.kind, 'canvas-uint');
assert.deepEqual(shape.outputPins, ['q0', 'q1', 'q2', 'q3']);

const boolShape = moduleShape(`
#include "systemc.h"
SC_MODULE(Buf) {
  sc_in<bool> a;
  sc_out<bool> y;
  void eval() { y.write(a.read()); }
  SC_CTOR(Buf) { SC_METHOD(eval); sensitive << a; }
};
`);
assert.equal(boolShape.kind, 'bool');

for (const [type, config] of Object.entries(GATES)) {
  if (type === 'CLOCK') continue;
  assert.equal(CELL_UNITS[type].file, config.sourceFile, type);
  assert.deepEqual(CELL_UNITS[type].inputs, config.inputPins, type);
  assert.deepEqual(CELL_UNITS[type].outputs, config.outputPins, type);
}

function circuit() {
  return {
    elements: [
      { uid: '1', type: 'VCC' },
      { uid: '2', type: 'AND' },
      { uid: '3', type: 'NOT' },
    ],
    connections: [
      { id: 1, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'a' },
      { id: 2, fromUid: '1', fromPin: 'y', toUid: '2', toPin: 'b' },
      { id: 3, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'a' },
    ],
  };
}

const gen = generateCircuit(circuit());
assert.equal(gen.error, null);
assert.ok(!gen.top.includes('#include "systemc.h"'));
assert.equal(gen.top.match(/rt_add_bool\("sig_1"\)/g).length, 1);
assert.ok(gen.top.includes('bind_And(e_2, "a", rt_ptr(sig_1));'));
assert.ok(gen.top.includes('bind_And(e_2, "b", rt_ptr(sig_1));'));
assert.equal(gen.units.filter((unit) => unit.id === 'cell_And').length, 1);
const sig1 = gen.manifest.byPin['1'].y;
assert.equal(gen.manifest.byPin['2'].a, sig1);
assert.equal(gen.manifest.byPin['2'].b, sig1);
assert.equal(gen.manifest.byPin['3'].a, gen.manifest.byPin['2'].y);
assert.equal(generateCircuit(circuit()).top, gen.top);

const moved = circuit();
moved.elements[0].x = 400;
assert.equal(circuitFingerprint(moved), circuitFingerprint(circuit()));

const loop = generateCircuit({
  elements: [{ uid: '1', type: 'NOT' }],
  connections: [{ id: 7, fromUid: '1', fromPin: 'y', toUid: '1', toPin: 'a' }],
});
assert.equal(loop.error, null);
assert.equal(loop.manifest.byPin['1'].a, loop.manifest.byPin['1'].y);
assert.ok(loop.top.includes('rt_add_bool("sig_7")'));
assert.ok(loop.top.includes('bind_Not(e_1, "a", rt_ptr(sig_7));'));
assert.ok(loop.top.includes('bind_Not(e_1, "y", rt_ptr(sig_7));'));

const clash = generateCircuit({
  elements: [
    { uid: '1', type: 'VCC' },
    { uid: '2', type: 'GND' },
    { uid: '3', type: 'AND' },
  ],
  connections: [
    { id: 1, fromUid: '1', fromPin: 'y', toUid: '3', toPin: 'a' },
    { id: 2, fromUid: '2', fromPin: 'y', toUid: '3', toPin: 'a' },
  ],
});
assert.ok(clash.error);

const expected = `/* Generated canvas netlist. Do not edit.
 * One sc_signal or sc_clock per wire net. Fan-out binds that channel to every input.
 * This file includes no SystemC headers, so a rewire recompiles only the top and relinks.
 */
extern "C" {

void rt_configure(int period_ns);
int rt_add_bool(const char* name);
int rt_add_clock(const char* name);
void* rt_ptr(int id);
void* mk_And(const char* name);
void bind_And(void* raw, const char* port, void* sig);
void* mk_Not(const char* name);
void bind_Not(void* raw, const char* port, void* sig);
void* mk_Vcc(const char* name);
void bind_Vcc(void* raw, const char* port, void* sig);

void circuit_build(void) {
  rt_configure(10);
  int pin_3_y = rt_add_bool("pin_3_y");
  int sig_1 = rt_add_bool("sig_1");
  int sig_3 = rt_add_bool("sig_3");

  void* e_1 = mk_Vcc("vcc_1");
  bind_Vcc(e_1, "y", rt_ptr(sig_1));
  void* e_2 = mk_And("and_2");
  bind_And(e_2, "a", rt_ptr(sig_1));
  bind_And(e_2, "b", rt_ptr(sig_1));
  bind_And(e_2, "y", rt_ptr(sig_3));
  void* e_3 = mk_Not("not_3");
  bind_Not(e_3, "a", rt_ptr(sig_3));
  bind_Not(e_3, "y", rt_ptr(pin_3_y));
}

}
`;
assert.equal(gen.top, expected);
console.log('netlist tests passed');

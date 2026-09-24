import { runClang } from '@yowasp/clang';

// Minimal test: compile a simple C function with no dependencies
try {
  const r = await runClang([
    "clang++","-std=c++17",
    "-x","c++","-",
    "-o","minimal.wasm",
    "--target=wasm32-wasi",
    "-Wl,--no-entry",
    "-Wl,--export=my_fn",
    "-O2",
    "-nostartfiles","-nodefaultlibs"
  ], {"stdin": 'extern "C" int my_fn() { return 42; }\n'});
  
  const wasm = r["minimal.wasm"];
  if (wasm) {
    const fs = await import('node:fs');
    fs.writeFileSync("minimal.wasm", Buffer.from(wasm));
    console.log("OK: " + wasm.byteLength + " bytes");
    const {WASI}=await import("node:wasi");
    const wasi=new WASI({version:"preview1",preopens:{}});
    const mod=await WebAssembly.compile(wasm);
    const inst=await WebAssembly.instantiate(mod,{wasi_snapshot_preview1:wasi.wasiImport});
    console.log("my_fn()=" + inst.exports.my_fn());
  } else {
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    console.log(stderr.slice(0,500));
  }
} catch(e) {
  console.log(e.message.slice(0,200));
  const stderr = e.stderr ? new TextDecoder().decode(e.stderr).slice(0,500) : "";
  if (stderr) console.log(stderr);
}
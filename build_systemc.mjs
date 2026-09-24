import { runClang } from '@yowasp/clang';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Build VFS with all .h and .cpp files
function buildTree(dp) {
  const t={};
  for (const e of readdirSync(dp,{withFileTypes:true})) {
    const fp=join(dp,e.name);
    if (e.isDirectory()) t[e.name]=buildTree(fp);
    else if (e.isFile()&&(e.name.endsWith(".cpp")||e.name.endsWith(".h")||e.name==="systemc"||e.name==="systemc.h"))
      t[e.name]=readFileSync(fp,"utf-8");
  }
  return t;
}
const srcTree = buildTree("systemc-src/src");

// Collect all .cpp files
let cppFiles=[];
function collectCpp(t,p=""){for(const[k,v]of Object.entries(t)){const path=p?p+"/"+k:k;if(typeof v==="string"&&k.endsWith(".cpp"))cppFiles.push(path);else if(typeof v==="object")collectCpp(v,path);}}
collectCpp(srcTree);

// Build unity source
let unity = `#include "systemc.h"\n\n`;
for (const c of cppFiles) unity += `#include "${c}"\n`;
const wasmMain = readFileSync("wasm_main.cpp","utf-8").replace("#include <systemc.h>","");
unity += `\n${wasmMain}`;

console.log(`Unity: ${unity.length} chars, ${cppFiles.length} .cpp files`);

// Pass stdin via RunOptions
let stdinPos = 0;
const stdinStream = (len) => {
  const remaining = unity.slice(stdinPos).length;
  if (remaining === 0) return null;
  const chunk = unity.slice(stdinPos, stdinPos + len);
  stdinPos += chunk.length;
  return new TextEncoder().encode(chunk);
};

try {
  const r = await runClang([
    "clang++","-std=c++17",
    "-x","c++","-",
    "-o","systemc_ring.wasm",
    "--target=wasm32-wasi",
    "-Wl,--no-entry",
    "-Wl,--export=init,--export=step,--export=reset_ring,--export=get_q,--export=set_enable",
    "-I.","-O2",
    "-fvisibility=default","-fno-threadsafe-statics",
    "-nostartfiles","-nodefaultlibs",
    "-Wno-parentheses-equality","-Wno-shift-count-overflow",
    "-Wno-undefined-var-template","-Wno-deprecated"
  ], srcTree, { stdin: stdinStream });
  
  const wasm = r["systemc_ring.wasm"];
  if (wasm) {
    writeFileSync("systemc_ring.wasm", Buffer.from(wasm));
    console.log("LINK OK: " + wasm.byteLength + " bytes");
    
    const {WASI}=await import("node:wasi");
    const wasi=new WASI({version:"preview1",preopens:{}});
    const mod=await WebAssembly.compile(wasm);
    const inst=await WebAssembly.instantiate(mod,{wasi_snapshot_preview1:wasi.wasiImport});
    console.log("Exports:", Object.keys(inst.exports).join(", "));
    if (inst.exports.init) {
      inst.exports.init();
      console.log("init() OK, q=" + inst.exports.get_q());
      for (let i=0;i<8;i++) {
        const q = inst.exports.step();
        console.log("step#" + i + ": q=" + q + " (0b" + q.toString(2).padStart(4,"0") + ")");
      }
    }
  } else {
    const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
    const undefs = stderr.split("\n").filter(l => l.includes("undefined"));
    if (undefs.length > 0) {
      console.log("UNDEFINED SYMBOLS:");
      undefs.forEach(l => console.log("  " + l));
    } else {
      console.log(stderr.slice(0,2000));
    }
  }
} catch(e) {
  const stderr = e.stderr ? new TextDecoder().decode(e.stderr) : "";
  const undefs = stderr.split("\n").filter(l => l.includes("undefined"));
  if (undefs.length > 0) {
    console.log("UNDEFINED SYMBOLS:");
    undefs.forEach(l => console.log("  " + l));
  } else {
    console.log(e.message.slice(0,200));
    console.log(stderr.slice(0,2000));
  }
}
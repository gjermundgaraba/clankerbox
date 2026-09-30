// Multi-role dispatch for the S4 SEA spike: clankerbox server|host|guest|cli.
const roles = new Set(["server", "host", "guest", "cli"]);
const role = process.argv[2];
if (!roles.has(role)) {
  process.stderr.write(`usage: clankerbox server|host|guest|cli\n`);
  process.exit(2);
}
const sea = require("node:sea");
const info = { role, isSea: sea.isSea(), node: process.version, platform: `${process.platform}-${process.arch}`, execPath: process.execPath, pid: process.pid };
process.stdout.write(JSON.stringify(info) + "\n");
if (process.argv[3] === "--jit-check") {
  // Exercise V8 JIT under the hardened runtime.
  let x = 0; for (let i = 0; i < 5e7; i++) x = (x + i * 31) % 1000003;
  process.stdout.write(`jit-ok ${x}\n`);
}
if (process.argv[3] === "--wasm-check") {
  // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
  const { add } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
  process.stdout.write(`wasm-ok ${add(40, 2)}\n`);
}

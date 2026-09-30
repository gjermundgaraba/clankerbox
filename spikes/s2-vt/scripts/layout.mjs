// Prints the parts of the pinned module's ABI layout this spike relies on.
import { readFile } from "node:fs/promises";
const bytes = await readFile(new URL("../../../internal/guest/vt/assets/ghostty-vt.wasm", import.meta.url));
const m = await WebAssembly.compile(bytes);
const i = new WebAssembly.Instance(m, {}).exports;
const p = i.ghostty_type_json();
const u = new Uint8Array(i.memory.buffer);
const layout = JSON.parse(new TextDecoder().decode(u.subarray(p, u.indexOf(0, p))));
for (const t of process.argv.slice(2)) {
  const x = layout.types[t];
  if (!x) { console.log("MISSING", t); continue; }
  console.log(t, JSON.stringify({ size: x.size, fields: x.fields && Object.fromEntries(Object.entries(x.fields).map(([k, v]) => [k, [v.offset, v.size, v.type]])), values: x.values }));
}
if (process.argv.length === 2) console.log(Object.keys(layout.types).join(" "));

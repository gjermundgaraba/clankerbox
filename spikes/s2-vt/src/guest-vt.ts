// Guest-side libghostty-vt terminal for Node, trimmed from Clankerdesk's
// packages/terminal-core GhosttyVt. The guest never renders, so there is no
// render state, key encoding or paste; it parses PTY output, answers queries,
// snapshots, restores and formats text.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

interface Field {
  offset: number;
  size: number;
  type: string;
}
interface AbiType {
  size: number;
  fields: { [name: string]: Field };
  values: { [name: string]: number };
}
interface Layout {
  schema: number;
  abi: { pointer_size: number; endian: string };
  types: { [name: string]: AbiType };
}
type Wasm = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
};

export const PINNED_SHA256 = "93fb99f59f7a6b7b657e17de1a2a932c2b59e1b3cbd16506941ccb84af6d1ef1";

/** Compiles the pinned module once; every terminal instantiates it separately. */
export async function loadModule(): Promise<WebAssembly.Module> {
  const bytes = await readFile(new URL("../../../internal/guest/vt/assets/ghostty-vt.wasm", import.meta.url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== PINNED_SHA256) throw new Error(`unexpected Ghostty WASM ${digest}`);
  return WebAssembly.compile(bytes);
}

// A JS function cannot be placed in a funcref table directly (WebAssembly.Function
// is not generally available). A tiny module imports it and re-exports it as a
// real wasm function with the C ABI signature, which the table accepts.
function trampoline(
  parameters: number,
  returns: boolean,
  callback: (...args: number[]) => number | void,
): WebAssembly.ExportValue {
  const signature = [
    1,
    0x60,
    parameters,
    ...Array<number>(parameters).fill(0x7f),
    returns ? 1 : 0,
    ...(returns ? [0x7f] : []),
  ];
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, signature.length, ...signature,
    2, 9, 1, 1, 101, 3, 99, 98, 107, 0, 0,
    7, 7, 1, 3, 99, 98, 107, 0, 0,
  ]);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { cbk: callback } }).exports
    .cbk;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Colors {
  foreground?: number;
  background?: number;
}

export class GuestVt {
  readonly wasm: Wasm;
  private readonly layout: Layout;
  private view?: DataView;
  private readonly allocations = new Map<number, number>();
  private readonly callbacks = new Map<string, number>();
  private readonly tableSlots: number[] = [];
  private terminal = 0;
  private slot = 0;
  private scratch = 0;
  private closed = false;
  /** Replies emitted by the engine during the current write, for the query filter. */
  replies = 0;
  private readonly onReply: (bytes: Uint8Array) => void;

  constructor(
    module: WebAssembly.Module,
    cols: number,
    rows: number,
    onReply: (bytes: Uint8Array) => void = () => {},
  ) {
    this.onReply = onReply;
    // SAFETY: the pinned module exports exactly this memory and table.
    this.wasm = new WebAssembly.Instance(module, {}).exports as Wasm;
    const json = this.call("ghostty_type_json");
    const bytes = new Uint8Array(this.wasm.memory.buffer);
    // SAFETY: ghostty_type_json is the module's generated C layout; the ABI is checked below.
    this.layout = JSON.parse(decoder.decode(bytes.subarray(json, bytes.indexOf(0, json)))) as Layout;
    if (this.layout.schema !== 1 || this.layout.abi.pointer_size !== 4 || this.layout.abi.endian !== "little")
      throw new Error("Unsupported Ghostty WASM ABI");
    this.slot = this.alloc(4);
    this.scratch = this.alloc(1024);
    this.check(this.call("ghostty_terminal_new", 0, this.slot, cols, rows));
    this.terminal = this.data.getUint32(this.slot, true);
    for (const [option, limit] of [
      ["SCROLLBACK_MAX_LINES", 10_000],
      ["SCROLLBACK_MAX_BYTES", 8 * 1024 * 1024],
      ["CONTINUATION_MAX_BYTES", 8 * 1024 * 1024],
    ] as const) {
      this.data.setUint32(this.scratch, limit, true);
      this.setOption(option, this.scratch);
    }
    this.setColors({ foreground: 0xd4dedb, background: 0x15191c });
    this.bind("WRITE_PTY", 4, false, (_terminal, _user, ptr, len) => {
      this.replies++;
      this.onReply(new Uint8Array(this.wasm.memory.buffer, ptr, len).slice());
    });
    this.bind("DEVICE_ATTRIBUTES", 3, true, (_terminal, _user, ptr) => {
      new Uint8Array(this.wasm.memory.buffer, ptr, this.type("GhosttyDeviceAttributes").size).fill(0);
      const primary = this.field("GhosttyDeviceAttributes", ptr, "primary");
      this.set("GhosttyDeviceAttributesPrimary", primary, "conformance_level", 62);
      this.set("GhosttyDeviceAttributesPrimary", primary, "num_features", 2);
      const features = this.field("GhosttyDeviceAttributesPrimary", primary, "features");
      this.data.setUint16(features, 22, true);
      this.data.setUint16(features + 2, 28, true);
      const secondary = this.field("GhosttyDeviceAttributes", ptr, "secondary");
      this.set("GhosttyDeviceAttributesSecondary", secondary, "device_type", 1);
      return 1;
    });
  }

  // Allocations may grow linear memory, which detaches earlier ArrayBuffers.
  private get data() {
    if (this.view?.buffer !== this.wasm.memory.buffer) this.view = new DataView(this.wasm.memory.buffer);
    return this.view;
  }
  private type(name: string) {
    const type = this.layout.types[name];
    if (!type) throw new Error(`Missing Ghostty ABI type: ${name}`);
    return type;
  }
  private value(type: string, name: string) {
    const value = this.type(type).values[name];
    if (value === undefined) throw new Error(`Missing Ghostty enum: ${type}.${name}`);
    return value;
  }
  private field(type: string, ptr: number, name: string) {
    return ptr + this.type(type).fields[name].offset;
  }
  private set(type: string, ptr: number, name: string, value: number) {
    const field = this.type(type).fields[name];
    const at = ptr + field.offset;
    if (field.size === 1) this.data.setUint8(at, value);
    else if (field.size === 2) this.data.setUint16(at, value, true);
    else this.data.setUint32(at, value, true);
  }
  private call(name: string, ...args: number[]): number {
    // SAFETY: every call names a pinned libghostty export with wasm32 numeric arguments.
    return (this.wasm[name] as (...args: number[]) => number)(...args);
  }
  private check(result: number) {
    if (result !== 0) throw new Error(`Ghostty operation failed (${result})`);
  }
  private alloc(size: number) {
    const ptr = this.call("ghostty_wasm_alloc", size);
    if (!ptr) throw new Error("Ghostty allocation failed");
    this.allocations.set(ptr, size);
    return ptr;
  }
  private free(ptr: number) {
    const size = this.allocations.get(ptr);
    if (size !== undefined) {
      this.call("ghostty_wasm_free", ptr, size);
      this.allocations.delete(ptr);
    }
  }
  private setOption(option: string, value: number, terminal = this.terminal) {
    this.check(this.call("ghostty_terminal_set", terminal, this.value("GhosttyTerminalOption", option), value));
  }
  private bind(option: string, parameters: number, returns: boolean, fn: (...args: number[]) => number | void) {
    const table = this.wasm.__indirect_function_table;
    const index = table.grow(1);
    table.set(index, trampoline(parameters, returns, fn));
    this.tableSlots.push(index);
    this.callbacks.set(option, index);
    this.setOption(option, index);
  }
  private withBytes<T>(bytes: Uint8Array, fn: (ptr: number, length: number) => T): T {
    const ptr = this.alloc(Math.max(1, bytes.length));
    try {
      new Uint8Array(this.wasm.memory.buffer).set(bytes, ptr);
      return fn(ptr, bytes.length);
    } finally {
      this.free(ptr);
    }
  }
  private live() {
    if (this.closed) throw new Error("terminal closed");
  }
  /** Two-pass buffer encoder: size query, then a sized call. */
  private encode(fn: (ptr: number, capacity: number) => number): Uint8Array {
    const status = fn(0, 0);
    if (status !== this.value("GhosttyResult", "OUT_OF_SPACE")) this.check(status);
    const length = this.data.getUint32(this.scratch, true);
    const ptr = this.alloc(Math.max(1, length));
    try {
      this.check(fn(ptr, length));
      return new Uint8Array(this.wasm.memory.buffer, ptr, this.data.getUint32(this.scratch, true)).slice();
    } finally {
      this.free(ptr);
    }
  }

  /** Feeds PTY output. Replies reach onReply synchronously, before this returns. */
  write(bytes: Uint8Array): number {
    this.live();
    const before = this.replies;
    this.withBytes(bytes, (ptr, length) => this.call("ghostty_terminal_vt_write", this.terminal, ptr, length));
    return this.replies - before;
  }

  /** The default colours the terminal reports (OSC 10/11) and renders with, as 0xRRGGBB. */
  setColors(colors: Colors) {
    this.live();
    for (const [option, color] of [
      ["COLOR_FOREGROUND", colors.foreground],
      ["COLOR_BACKGROUND", colors.background],
    ] as const) {
      if (color === undefined) continue;
      this.data.setUint8(this.scratch, (color >> 16) & 0xff);
      this.data.setUint8(this.scratch + 1, (color >> 8) & 0xff);
      this.data.setUint8(this.scratch + 2, color & 0xff);
      this.setOption(option, this.scratch);
    }
  }

  resize(cols: number, rows: number) {
    this.live();
    this.check(this.call("ghostty_terminal_resize", this.terminal, cols, rows, 8, 16));
  }

  /** Complete CRC-protected snapshot: both screens, modes and unfinished input. */
  snapshot(): Uint8Array {
    this.live();
    return this.encode((ptr, cap) => this.call("ghostty_snapshot_encode_buf", this.terminal, ptr, cap, this.scratch));
  }

  /** Atomically replaces the terminal from a snapshot; restoring emits no replies. */
  restore(snapshot: Uint8Array) {
    this.live();
    this.withBytes(snapshot, (ptr, length) => {
      this.check(this.call("ghostty_snapshot_decoder_new_buf", 0, this.slot, ptr, length));
      const decoderHandle = this.data.getUint32(this.slot, true);
      let replacement = 0;
      try {
        this.data.setUint8(this.scratch, 1);
        this.check(
          this.call("ghostty_snapshot_decoder_set", decoderHandle,
            this.value("GhosttySnapshotDecoderOption", "RETAIN_CONTINUATION"), this.scratch),
        );
        this.check(this.call("ghostty_snapshot_decoder_decode", decoderHandle, this.slot));
        replacement = this.data.getUint32(this.slot, true);
        for (const [option, index] of this.callbacks) this.setOption(option, index, replacement);
        this.call("ghostty_terminal_free", this.terminal);
        this.terminal = replacement;
        replacement = 0;
      } finally {
        this.call("ghostty_snapshot_decoder_free", decoderHandle);
        if (replacement) this.call("ghostty_terminal_free", replacement);
      }
    });
  }

  private format(emit: "PLAIN" | "VT", extras: boolean): Uint8Array {
    const t = "GhosttyFormatterTerminalOptions";
    const options = this.alloc(this.type(t).size);
    new Uint8Array(this.wasm.memory.buffer, options, this.type(t).size).fill(0);
    try {
      this.set(t, options, "size", this.type(t).size);
      this.set(t, options, "emit", this.value("GhosttyFormatterFormat", emit));
      this.set(t, options, "trim", 1);
      const extra = this.field(t, options, "extra");
      this.set("GhosttyFormatterTerminalExtra", extra, "size", this.type("GhosttyFormatterTerminalExtra").size);
      const screen = this.field("GhosttyFormatterTerminalExtra", extra, "screen");
      this.set("GhosttyFormatterScreenExtra", screen, "size", this.type("GhosttyFormatterScreenExtra").size);
      if (extras) {
        for (const name of ["palette", "modes", "scrolling_region", "tabstops", "pwd", "keyboard"])
          this.set("GhosttyFormatterTerminalExtra", extra, name, 1);
        for (const name of ["cursor", "style", "hyperlink", "protection", "kitty_keyboard", "charsets"])
          this.set("GhosttyFormatterScreenExtra", screen, name, 1);
      }
      this.check(this.call("ghostty_formatter_terminal_new", 0, this.slot, this.terminal, options));
      const formatter = this.data.getUint32(this.slot, true);
      try {
        return this.encode((ptr, cap) => this.call("ghostty_formatter_format_buf", formatter, ptr, cap, this.scratch));
      } finally {
        this.call("ghostty_formatter_free", formatter);
      }
    } finally {
      this.free(options);
    }
  }

  /** The active screen as plain text, trailing whitespace trimmed (Go Terminal.Text). */
  text(): string {
    this.live();
    return decoder.decode(this.format("PLAIN", false));
  }

  /** The formatter's VT repaint with every extra, for size comparison only. */
  vtRepaint(): Uint8Array {
    this.live();
    return this.format("VT", true);
  }

  private get32(key: string, size = 4): number {
    this.live();
    this.check(this.call("ghostty_terminal_get", this.terminal, this.value("GhosttyTerminalData", key), this.scratch));
    return size === 1 ? this.data.getUint8(this.scratch) : size === 2 ? this.data.getUint16(this.scratch, true) : this.data.getUint32(this.scratch, true);
  }
  cursor() {
    return { x: this.get32("CURSOR_X", 2), y: this.get32("CURSOR_Y", 2) };
  }
  size() {
    return { cols: this.get32("COLS", 2), rows: this.get32("ROWS", 2) };
  }
  activeScreen(): "primary" | "alternate" {
    return this.get32("ACTIVE_SCREEN") === this.value("GhosttyTerminalScreen", "ALTERNATE") ? "alternate" : "primary";
  }
  scrollbackRows() {
    return this.get32("SCROLLBACK_ROWS");
  }
  /** True when the parser is between sequences (no unfinished escape or UTF-8). */
  vtGround() {
    return this.get32("VT_GROUND", 1) !== 0;
  }
  kittyKeyboardFlags() {
    return this.get32("KITTY_KEYBOARD_FLAGS", 1);
  }
  /** Whether any mouse tracking mode is on (a bool in the ABI). */
  mouseTracking() {
    return this.get32("MOUSE_TRACKING", 1) !== 0;
  }
  /** Reads a mode; DEC private modes are packed as the value with the ANSI bit clear. */
  mode(packed: number): boolean {
    this.live();
    const t = "GhosttyTerminalModeConfig";
    this.set(t, this.scratch, "mode", packed);
    this.set(t, this.scratch, "value", 0);
    this.check(this.call("ghostty_terminal_get", this.terminal, this.value("GhosttyTerminalData", "MODE"), this.scratch));
    return this.data.getUint8(this.field(t, this.scratch, "value")) !== 0;
  }
  memoryBytes() {
    return this.wasm.memory.buffer.byteLength;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.call("ghostty_terminal_free", this.terminal);
    for (const ptr of [...this.allocations.keys()]) this.free(ptr);
    for (const index of this.tableSlots) this.wasm.__indirect_function_table.set(index, null);
  }
}

export const bytes = (text: string) => encoder.encode(text);
export const str = (data: Uint8Array) => decoder.decode(data);

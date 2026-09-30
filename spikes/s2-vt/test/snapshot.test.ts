// Criteria 5 and 6: exact snapshot round trips from the Node guest engine into
// Clankerdesk's own engine (imported read-only from its repository), and the
// final-screen plain-text capture for ended sessions.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, GuestVt, bytes } from "../src/guest-vt.ts";
import { GhosttyVt } from "/Users/gg/ws/pers/clankerdesk/packages/terminal-core/src/index.ts";

let module: WebAssembly.Module;
before(async () => {
  module = await loadModule();
});

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

function state(vt: GuestVt) {
  return {
    // The VT repaint with every extra: cells, styles, modes, cursor, charsets.
    repaint: Buffer.from(vt.vtRepaint()).toString("base64"),
    text: vt.text(),
    cursor: vt.cursor(),
    screen: vt.activeScreen(),
    ground: vt.vtGround(),
    cursorKeys: vt.mode(1),
    bracketedPaste: vt.mode(2004),
    mouse: vt.mouseTracking(),
    kitty: vt.kittyKeyboardFlags(),
    scrollback: vt.scrollbackRows(),
  };
}

/** Reads a Clankerdesk terminal's full state through the guest engine. */
function viaGuest(mirror: GhosttyVt) {
  const probe = new GuestVt(module, 1, 1);
  try {
    probe.restore(mirror.snapshot());
    return state(probe);
  } finally {
    probe.dispose();
  }
}

/**
 * Guest parses prefix, Clankerdesk's mirror restores the guest snapshot at the
 * cut, both continue with suffix. A fresh terminal fed the whole stream is the
 * uninterrupted reference.
 */
function roundTrip(
  prefix: Uint8Array,
  suffix: Uint8Array,
  atCut?: (guest: GuestVt, mirror: GhosttyVt) => void,
  cutOps?: (vt: { resize(cols: number, rows: number): void }) => void,
  exact = true,
) {
  const guest = new GuestVt(module, 80, 24);
  const mirror = new GhosttyVt(module, 20, 4);
  const reference = new GuestVt(module, 80, 24);
  try {
    guest.write(prefix);
    mirror.restore(guest.snapshot());
    assert.deepEqual(mirror.snapshot(), guest.snapshot(), "mirror equals guest at the cut");
    atCut?.(guest, mirror);
    for (const vt of [guest, mirror]) cutOps?.(vt);
    guest.write(suffix);
    mirror.writeBytes(suffix);
    if (cutOps) {
      reference.write(prefix);
      cutOps(reference);
      reference.write(suffix);
    } else reference.write(concat(prefix, suffix));
    assert.deepEqual(guest.snapshot(), reference.snapshot(), "guest equals uninterrupted reference");
    // A restored terminal's internal page layout can differ once history exists,
    // so byte equality after continuing holds only for small screens. The state
    // itself (text with history, repaint with every extra, modes) must match.
    if (exact) assert.deepEqual(mirror.snapshot(), reference.snapshot(), "mirror equals uninterrupted reference");
    assert.deepEqual(viaGuest(mirror), state(reference));
    return state(reference);
  } finally {
    guest.dispose();
    mirror.dispose();
    reference.dispose();
  }
}

test("(a) an escape sequence split across the cut", () => {
  const end = roundTrip(bytes("$ echo \x1b[3"), bytes("1mbold\x1b[0m done\r\n"), (guest) =>
    assert.equal(guest.vtGround(), false, "cut is mid-sequence"),
  );
  assert.equal(end.text, "$ echo bold done");
});

test("(b) a UTF-8 character split across the cut", () => {
  const end = roundTrip(new Uint8Array([...bytes("hello "), 0xf0, 0x9f]), new Uint8Array([0x98, 0x80, ...bytes("!")]));
  assert.equal(end.text, "hello 😀!");
});

test("(c) a reconnect inside the alternate screen, then a return to primary", () => {
  const prefix = bytes(
    "$ ls\r\nfile1 file2\r\n$ vim\r\n" +
      // TUI: alternate screen with the modes that drive key encoding.
      "\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[>1u\x1b[H\x1b[2JTUI SCREEN\x1b[5;3Hcursor here",
  );
  const suffix = bytes(" more\x1b[<u\x1b[?1000l\x1b[?2004l\x1b[?1l\x1b[?1049l$ echo back\r\nback\r\n");
  const end = roundTrip(prefix, suffix, (guest, mirror) => {
    const cut = viaGuest(mirror);
    assert.equal(cut.screen, "alternate");
    assert.deepEqual(
      { cursorKeys: cut.cursorKeys, bracketedPaste: cut.bracketedPaste, mouse: cut.mouse, kitty: cut.kitty },
      { cursorKeys: true, bracketedPaste: true, mouse: true, kitty: 1 },
    );
    assert.equal(cut.text, "TUI SCREEN\n\n\n\n  cursor here");
    // Key encoding in Clankerdesk's browser engine follows the restored modes.
    const direct = new GhosttyVt(module, 80, 24);
    try {
      direct.writeBytes(prefix);
      for (const key of [
        { key: "ArrowUp", code: "ArrowUp" },
        { key: "a", code: "KeyA" },
        { key: "Escape", code: "Escape" },
      ]) {
        const event = { ...key, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, type: "keydown", repeat: false };
        assert.equal(mirror.encodeKey(event), direct.encodeKey(event), `encodeKey ${key.key}`);
      }
      assert.equal(mirror.paste("x"), direct.paste("x"));
    } finally {
      direct.dispose();
    }
    assert.equal(guest.activeScreen(), "alternate");
  });
  assert.equal(end.screen, "primary");
  assert.equal(end.text, "$ ls\nfile1 file2\n$ vim\n$ echo back\nback");
  assert.deepEqual([end.cursorKeys, end.bracketedPaste, end.mouse, end.kitty], [false, false, false, 0]);
});

test("a cut with scrollback and a resize at the cut stays semantically exact", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} \x1b[3${i % 8}mcolour\x1b[0m`).join("\r\n");
  const end = roundTrip(bytes(lines), bytes("\r\nafter"), undefined, (vt) => vt.resize(100, 30), false);
  assert.ok(end.scrollback > 0);
});

test("(6) final-screen capture: the active screen's text including its history, trimmed", () => {
  const vt = new GuestVt(module, 40, 6);
  try {
    vt.write(bytes("first   \r\n\x1b[1msecond\x1b[0m\r\n\r\n"));
    assert.equal(vt.text(), "first\nsecond");
    assert.deepEqual(vt.cursor(), { x: 0, y: 3 });
    // A program that died in the alternate screen: the final screen is what was shown.
    vt.write(bytes("\x1b[?1049h\x1b[HTUI died"));
    assert.equal(vt.text(), "TUI died");
    // Finding: the plain formatter (the same call as Go Terminal.Text) includes
    // the active screen's scrollback, not only the visible rows.
    const tall = new GuestVt(module, 20, 3);
    try {
      tall.write(bytes("a\r\nb\r\nc\r\nd\r\ne"));
      assert.equal(tall.text(), "a\nb\nc\nd\ne");
    } finally {
      tall.dispose();
    }
  } finally {
    vt.dispose();
  }
});

test("after a restore, history eviction can differ from the original, but only in the oldest lines", () => {
  const block = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `L${from + i} \x1b[3${(from + i) % 8}m${"w".repeat(40)}\x1b[0m`).join("\r\n") + "\r\n";
  const original = new GuestVt(module, 80, 24);
  const restored = new GuestVt(module, 1, 1);
  const resync = new GuestVt(module, 1, 1);
  try {
    original.write(bytes(block(0, 3000)));
    restored.restore(original.snapshot());
    for (let k = 0; k < 12; k++) {
      const chunk = bytes(block(3000 + k * 1000, 1000));
      original.write(chunk);
      restored.write(chunk);
    }
    const a = original.text().split("\n");
    const b = restored.text().split("\n");
    assert.notEqual(a.length, b.length, "eviction boundary moved (engine property, not Node)");
    const shorter = Math.min(a.length, b.length);
    assert.deepEqual(a.slice(-shorter), b.slice(-shorter), "every line both still hold is identical");
    assert.deepEqual(original.cursor(), restored.cursor());
    resync.restore(original.snapshot());
    assert.deepEqual(resync.snapshot(), original.snapshot(), "a fresh snapshot resynchronises exactly");
  } finally {
    original.dispose();
    restored.dispose();
    resync.dispose();
  }
});

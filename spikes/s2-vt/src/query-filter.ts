// Port of internal/guest/session/queries.go without offsets, spans or replay,
// which only served resume. The scanner finds sequence boundaries; the
// terminating byte of each sequence is written to the engine alone, and a reply
// during that write marks the sequence as an answered query, omitted from the
// filtered stream. Which sequences are queries remains the engine's knowledge.

const maxHeld = 4096;

// Plain constants: Node's type stripping has no enums.
const Scan = { Ground: 0, Escape: 1, Csi: 2, Osc: 3, String: 4, OscEscape: 5, StringEscape: 6 } as const;
type Scan = (typeof Scan)[keyof typeof Scan];
const Event = { Text: 0, Begin: 1, Body: 2, End: 3, Abort: 4, StringEsc: 5, StringEnd: 6, StringBroken: 7 } as const;
type Event = (typeof Event)[keyof typeof Event];

const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const ESC = 0x1b;

export class QueryFilter {
  private state: Scan = Scan.Ground;
  private held: number[] = [];
  private passing = false;
  private answered = false;
  /** Answered sequences omitted so far, for tests. */
  omitted: string[] = [];

  private step(b: number): Event {
    switch (this.state) {
      case Scan.Ground:
        if (b === ESC) {
          this.state = Scan.Escape;
          return Event.Begin;
        }
        return Event.Text;
      case Scan.Escape:
        if (b === ESC) return Event.Begin;
        if (b === CAN || b === SUB) {
          this.state = Scan.Ground;
          return Event.Abort;
        }
        if (b === 0x5b) this.state = Scan.Csi;
        else if (b === 0x5d) this.state = Scan.Osc;
        else if (b === 0x50 || b === 0x5f || b === 0x5e || b === 0x58) this.state = Scan.String;
        else if (b >= 0x30 && b <= 0x7e) {
          this.state = Scan.Ground;
          return Event.End;
        }
        return Event.Body;
      case Scan.Csi:
        if (b === ESC) {
          this.state = Scan.Escape;
          return Event.Begin;
        }
        if (b === CAN || b === SUB) {
          this.state = Scan.Ground;
          return Event.Abort;
        }
        if (b >= 0x40 && b <= 0x7e) {
          this.state = Scan.Ground;
          return Event.End;
        }
        return Event.Body;
      case Scan.Osc:
      case Scan.String:
        if (b === ESC) {
          this.state = this.state === Scan.Osc ? Scan.OscEscape : Scan.StringEscape;
          return Event.StringEsc;
        }
        if (b === CAN || b === SUB) {
          this.state = Scan.Ground;
          return Event.Abort;
        }
        if (b === BEL && this.state === Scan.Osc) {
          this.state = Scan.Ground;
          return Event.End;
        }
        return Event.Body;
      case Scan.OscEscape:
      case Scan.StringEscape:
        if (b === 0x5c) {
          this.state = Scan.Ground;
          return Event.StringEnd;
        }
        this.state = Scan.Escape;
        return Event.StringBroken;
    }
  }

  /**
   * Feeds one output chunk to the engine through write, which reports whether
   * the engine replied, and returns the filtered bytes for a viewer terminal.
   * Everything happens synchronously: no await may separate the engine write,
   * the reply enqueue and the fan-out.
   */
  ingest(chunk: Uint8Array, write: (bytes: Uint8Array) => boolean): Uint8Array {
    const out: number[] = [];
    let written = 0;
    const isolate = (i: number) => {
      if (i > written) write(chunk.subarray(written, i));
      written = i + 1;
      return write(chunk.subarray(i, i + 1));
    };
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      let event: Event = this.step(b);
      if (event === Event.StringBroken) {
        this.finish(out, this.answered, 1);
        event = this.step(b);
      }
      switch (event) {
        case Event.Text:
          out.push(b);
          break;
        case Event.Begin:
          this.finish(out, false, 0);
          this.hold(out, b);
          break;
        case Event.Body:
          this.hold(out, b);
          break;
        case Event.End: {
          const replied = isolate(i);
          this.hold(out, b);
          this.finish(out, replied, 0);
          break;
        }
        case Event.Abort:
          this.hold(out, b);
          this.finish(out, false, 0);
          break;
        case Event.StringEsc:
          this.answered = isolate(i);
          if (this.passing) this.held = [b];
          else this.hold(out, b);
          break;
        case Event.StringEnd:
          this.hold(out, b);
          this.finish(out, this.answered, 0);
          break;
      }
    }
    if (written < chunk.length) write(chunk.subarray(written));
    return Uint8Array.from(out);
  }

  private hold(out: number[], b: number) {
    if (this.passing) {
      out.push(...this.held, b);
      this.held = [];
      return;
    }
    this.held.push(b);
    if (this.held.length > maxHeld) {
      for (const x of this.held) out.push(x);
      this.held = [];
      this.passing = true;
    }
  }

  private finish(out: number[], answered: boolean, keep: number) {
    const decided = this.held.slice(0, this.held.length - keep);
    if (answered && !this.passing) this.omitted.push(String.fromCharCode(...decided));
    else for (const x of decided) out.push(x);
    this.held = this.held.slice(decided.length);
    this.passing = false;
    this.answered = false;
  }

  /** Releases a sequence the process never completed (at exit). */
  flush(): Uint8Array {
    const data = Uint8Array.from(this.held);
    this.held = [];
    return data;
  }
}

import { readFileSync } from "node:fs";

import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { parse } from "../../../src/platform/tart/launchd.ts";

const printed = (name: string) =>
  readFileSync(new URL(`launchctl/${name}.txt`, import.meta.url), "utf-8");

const program = [
  "/Users/operator/.local/opt/tart/2.41.1/tart.app/Contents/MacOS/tart",
  "run",
  "--no-graphics",
  "--net-softnet-block=@host",
  "--suspendable",
  "rcv-f5x",
];

describe("launchctl print, as macOS 27.2 prints a job through its life", () => {
  it("reads a VM's job running, starting, exited and never run, and a job launchd waits to respawn as running", () => {
    expect([
      parse(printed("running")),
      parse(printed("starting")),
      parse(printed("exited")),
      parse(printed("never-ran")),
      parse(printed("spawn-scheduled")),
    ]).toStrictEqual([
      Result.succeed({ _tag: "running", program }),
      Result.succeed({ _tag: "running", program }),
      Result.succeed({ _tag: "exited", program, lastExit: 0 }),
      Result.succeed({ _tag: "exited", program, lastExit: undefined }),
      Result.succeed({ _tag: "running", program: ["/usr/bin/false"] }),
    ]);
  });

  it("reads no job from a print without its state or arguments, or with a state macOS 27.2 never printed", () => {
    expect([
      parse(printed("running").replace("\tstate = running\n", "")),
      parse(
        printed("exited").replace(/\targuments = \{\n(?:\t\t.*\n)*\t\}\n/u, "")
      ),
      parse(printed("not-loaded")),
      parse(""),
      parse(
        printed("running").replace("\tstate = running\n", "\tstate = waiting\n")
      ),
    ]).toStrictEqual([
      Result.fail("no state or arguments this host reads"),
      Result.fail("no state or arguments this host reads"),
      Result.fail("no state or arguments this host reads"),
      Result.fail("no state or arguments this host reads"),
      Result.fail(`the state "waiting", which this host doesn't know`),
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { names, tartRuns } from "../../../src/platform/tart/runs.ts";

const binary = "/opt/tart/2.41.1/bin/tart-2.41.1";

const line = (pid: number, name: string, args: string) =>
  `${String(pid).padStart(5)} ${name.padEnd(16)} ${args}`;

describe("the tart run processes ps shows", () => {
  it("are the host's binary's whatever its name, and any executable named tart's, each with the arguments after run", () => {
    const processes = [
      line(
        52_085,
        "tart",
        "/Users/operator/.local/opt/tart/2.41.1/tart.app/Contents/MacOS/tart run --no-graphics --net-softnet-block=@host --suspendable rcv-f5x"
      ),
      line(
        100,
        "tart-2.41.1",
        `${binary} run --no-graphics --suspendable cbx-mac-m-dev-01234567`
      ),
      line(101, "tart", "tart run ubuntu-linux"),
      line(102, "tart", "tart run vm-b --no-graphics"),
      line(
        103,
        "tart",
        "/Applications/Tart App/tart.app/Contents/MacOS/tart run --dir=a:/b c"
      ),
      line(
        104,
        "tart",
        "/opt/tart/tart.app/Contents/MacOS/tart exec -i vm-a sudo -n -- /usr/local/bin/tart run foo"
      ),
      line(105, "tart", "(tart)"),
      line(106, "tart", "/opt/tart/tart.app/Contents/MacOS/tart run"),
      line(107, "bash", "bash -c tart run x"),
      line(108, "sh", `sh -c ${binary} run --no-graphics y`),
      line(
        109,
        "Code Helper (Re",
        "/Applications/Code.app/Contents/Frameworks/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer) --type=renderer"
      ),
      line(110, "tart241", "/opt/tart/tart241 run --no-graphics vm-c"),
      line(
        111,
        "tart",
        "/Users/operator/rcv-f5b/bin/tart-2.41.1 run --no-graphics --net-softnet-block=@host rcv-f5b-vm"
      ),
      line(112, "tart", "/opt/tart builds/tart-2 run vm-e"),
      "",
    ].join("\n");

    expect(tartRuns(processes, binary)).toStrictEqual([
      {
        pid: 52_085,
        arguments: [
          "--no-graphics",
          "--net-softnet-block=@host",
          "--suspendable",
          "rcv-f5x",
        ],
      },
      {
        pid: 100,
        arguments: ["--no-graphics", "--suspendable", "cbx-mac-m-dev-01234567"],
      },
      { pid: 101, arguments: ["ubuntu-linux"] },
      { pid: 102, arguments: ["vm-b", "--no-graphics"] },
      { pid: 103, arguments: ["--dir=a:/b", "c"] },
      {
        pid: 111,
        arguments: ["--no-graphics", "--net-softnet-block=@host", "rcv-f5b-vm"],
      },
    ]);
  });

  it("run a VM whose handle is among their arguments, wherever it stands", () => {
    const [own, flagged] = tartRuns(
      [
        line(
          100,
          "tart-2.41.1",
          `${binary} run --no-graphics cbx-mac-m-dev-01234567`
        ),
        line(101, "tart", "tart run cbx-mac-m-dev-89abcdef --no-graphics"),
      ].join("\n"),
      binary
    );

    expect(
      [own, flagged].flatMap((run) =>
        run === undefined
          ? []
          : [
              names(run, "cbx-mac-m-dev-01234567"),
              names(run, "cbx-mac-m-dev-89abcdef"),
              names(run, "--no-graphics-not"),
            ]
      )
    ).toStrictEqual([true, false, false, false, true, false]);
  });
});

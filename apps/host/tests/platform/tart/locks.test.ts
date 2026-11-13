import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { holders } from "../../../src/platform/tart/locks.ts";

const paths = ["/home/vms/a/config.json", "/home/vms/b/config.json"];

describe("the lock reader's answer", () => {
  it("gives each path's holder, 0 for a file no run locks or one that's gone", () => {
    expect(
      holders(paths, `5001\t${paths[0]}\nnone\t${paths[1]}\nend\n`)
    ).toStrictEqual(Result.succeed([5001, 0]));
    expect(holders([], "end\n")).toStrictEqual(Result.succeed([]));
  });

  it("is no answer when it's cut short, out of order, or names an error", () => {
    expect(
      [
        `5001\t${paths[0]}\n`,
        `5001\t${paths[0]}\n0\t${paths[1]}\n`,
        `0\t${paths[1]}\n0\t${paths[0]}\nend\n`,
        `error Permission denied\t${paths[0]}\n0\t${paths[1]}\nend\n`,
        `0\t${paths[0]}\nend\n`,
        "",
      ].map((output) => Result.isFailure(holders(paths, output)))
    ).toStrictEqual([true, true, true, true, true, true]);
  });
});

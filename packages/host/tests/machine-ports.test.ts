import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import {
  defaultMachinePorts,
  pickPort,
  type PortRange,
  type Probe,
  reservedPorts,
} from "../src/machine-ports.ts";

const probing = (busy: ReadonlySet<number>) => {
  const probed: Array<number> = [];

  const probe: Probe = {
    free: (_address, port) =>
      Effect.sync(() => {
        probed.push(port);

        return !busy.has(port);
      }),
  };

  return { probe, probed };
};

const range: PortRange = { first: 10_000, last: 10_004 };

it.effect("the first port in the range that no row holds and the probe finds free is picked", () =>
  Effect.gen(function* () {
    const { probe, probed } = probing(new Set([10_001]));

    const port = yield* pickPort(probe, "127.0.0.1", range, new Set([10_000, 10_002]));

    expect(port).toBe(10_003);
    expect(probed).toEqual([10_001, 10_003]);
  }),
);

it.effect("a range with no free port is Capacity, naming the range and address", () =>
  Effect.gen(function* () {
    const { probe } = probing(new Set([10_003, 10_004]));

    const error = yield* Effect.flip(
      pickPort(probe, "100.64.0.10", range, new Set([10_000, 10_001, 10_002])),
    );

    expect(error._tag).toBe("Capacity");
    expect(error.message).toBe("no free port in 10000-10004 on 100.64.0.10");
  }),
);

it("the default range lies below every reserved range", () => {
  for (const reserved of reservedPorts) {
    expect(defaultMachinePorts.last).toBeLessThan(reserved.first);
  }
});

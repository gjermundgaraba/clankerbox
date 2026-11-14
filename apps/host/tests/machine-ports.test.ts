import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vite-plus/test";

import { runtimes } from "../src/composition/runtimes.ts";
import { defaultMachinePorts, PortProbe } from "../src/machine-ports.ts";
import type { PortRange, Probe } from "../src/machine-ports.ts";
import { defaultEphemeralPorts } from "../src/platform/box.ts";
import * as Reach from "../src/reach.ts";

const probing = (busy: ReadonlySet<number>) => {
  const probed: number[] = [];

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

const reachesOn = (probe: Probe, address: string) =>
  Reach.make({ _tag: "published", address }, range).pipe(
    Effect.provide(
      Layer.merge(Layer.succeed(PortProbe, probe), Layer.mock(Reach.Relays)({}))
    )
  );

it.effect(
  "the first port in the range that no row holds and the probe finds free is picked",
  () =>
    Effect.gen(function* () {
      const { probe, probed } = probing(new Set([10_001]));

      const reaches = yield* reachesOn(probe, "127.0.0.1");
      const port = yield* reaches.pick(new Set([10_000, 10_002]));

      expect(port).toBe(10_003);
      expect(probed).toStrictEqual([10_001, 10_003]);
    })
);

it.effect(
  "a range with no free port is Capacity, naming the range and address",
  () =>
    Effect.gen(function* () {
      const { probe } = probing(new Set([10_003, 10_004]));

      const reaches = yield* reachesOn(probe, "100.64.0.10");

      const error = yield* Effect.flip(
        reaches.pick(new Set([10_000, 10_001, 10_002]))
      );

      expect(error._tag).toBe("Capacity");
      expect(error.message).toBe("no free port in 10000-10004 on 100.64.0.10");
    })
);

describe("reserved ports", () => {
  it("the default range lies below every reserved range, of any runtime", () => {
    const reservedPorts = [
      ...["linux", "darwin", "freebsd"].map(defaultEphemeralPorts),
      ...Object.values(runtimes).flatMap((runtime) =>
        "reservedPorts" in runtime ? runtime.reservedPorts : []
      ),
    ];

    expect(reservedPorts.map(({ owner }) => owner)).toContain(
      "smolvm's fork ports"
    );

    for (const reserved of reservedPorts) {
      expect(defaultMachinePorts.last).toBeLessThan(reserved.first);
    }
  });
});

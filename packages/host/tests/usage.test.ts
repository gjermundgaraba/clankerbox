import { it } from "@effect/vitest";
import { Machine as MachineResource } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";

import type { Held, MachineRef, MachineState } from "../src/runtime.ts";
import { checkRamBudget } from "../src/usage.ts";

const Machine = Schema.Struct({
  ramMib: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
  booting: Schema.Boolean,
  state: MachineResource.fields.state,
});

const ref = (index: number, ramMib: number): MachineRef => ({
  id: `linux_m${index}`,
  name: `m${index}`,
  instance: index.toString(16).padStart(32, "0"),
  cpu: 1,
  ramMib,
  diskGib: 10,
  port: 10_000 + index,
});

type Placed = Held & { readonly state: MachineState };

const admits = (
  target: number,
  others: ReadonlyArray<typeof Machine.Type>,
  budgetMib: number
) =>
  Effect.gen(function* () {
    const machine = ref(0, target);

    const machines: readonly Placed[] = [
      { machine, booting: true, state: "stopped" },
      ...others.map((other, index) => ({
        ...other,
        machine: ref(index + 1, other.ramMib),
      })),
    ];

    const asked: Array<readonly MachineRef[]> = [];

    const observe = (refs: readonly MachineRef[]) =>
      Effect.sync(() => {
        asked.push(refs);

        return refs.map(
          (asking) =>
            machines.find((held) => held.machine.id === asking.id)?.state ??
            "missing"
        );
      });

    const checked = yield* Effect.exit(
      checkRamBudget(
        budgetMib,
        { action: "startMachine", machine, machines },
        observe
      )
    );

    expect(asked).toStrictEqual([
      machines.flatMap((held) => (held.booting ? [] : [held.machine])),
    ]);

    if (Exit.isSuccess(checked)) {
      return true;
    }

    const error = yield* Effect.flip(checked);

    expect(error._tag).toBe("Capacity");
    expect(error.message).toMatch(
      /^startMachine linux_m0 needs \S+ of RAM, and /u
    );

    return false;
  });

const Ram = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 }));

const Budget = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 262_144 })
);

it.effect.prop(
  "alone, a boot is refused exactly when its own RAM passes the budget",
  { target: Ram, budget: Budget },
  ({ target, budget }) =>
    Effect.gen(function* () {
      expect(yield* admits(target, [], budget)).toBe(target <= budget);
    })
);

it.effect.prop(
  "another machine that boots, runs or can't be read adds its RAM; one stopped, paused or missing adds none",
  {
    target: Ram,
    others: Schema.Array(Machine),
    extra: Machine,
    budget: Budget,
  },
  ({ target, others, extra, budget }) =>
    Effect.gen(function* () {
      const counts =
        extra.booting || extra.state === "running" || extra.state === "unknown";

      const before = yield* admits(target, others, budget);

      const after = yield* admits(
        target,
        [...others, extra],
        budget + (counts ? extra.ramMib : 0)
      );

      expect(after).toBe(before);
    })
);

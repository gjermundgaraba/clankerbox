import { it } from "@effect/vitest";
import { Machine as MachineResource } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";

import { Handle } from "../src/runtime.ts";
import type { Held, MachineState, Sized, Target } from "../src/runtime.ts";
import { checkRamBudget } from "../src/usage.ts";

const Machine = Schema.Struct({
  ramMib: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
  held: Schema.Literals(["found", "unread", "booting"]),
  state: MachineResource.fields.state,
});

const ref = (index: number, ramMib: number): Sized => ({
  name: `m${index}`,
  instance: index.toString(16).padStart(32, "0"),
  handle: Handle.make(`m${index}-vm`),
  cpu: 1,
  ramMib,
  diskGib: 10,
});

type Placed = Held & { readonly state: MachineState };

const placed = (
  held: Held["_tag"],
  machine: Sized,
  state: MachineState
): Placed => ({ _tag: held, machine, state });

const admits = (
  target: number,
  others: ReadonlyArray<typeof Machine.Type>,
  budgetMib: number,
  heldMib = 0
) =>
  Effect.gen(function* () {
    const machine = ref(0, target);

    const machines: readonly Placed[] = [
      placed("booting", machine, "stopped"),
      ...others.map((other, index) =>
        placed(other.held, ref(index + 1, other.ramMib), other.state)
      ),
    ];

    const asked: Array<readonly Target[]> = [];

    const observe = (refs: readonly Target[]) =>
      Effect.sync(() => {
        asked.push(refs);

        return new Map(
          refs.map((asking) => [
            asking.name,
            machines.find((held) => held.machine.name === asking.name)?.state ??
              "missing",
          ])
        );
      });

    const checked = yield* Effect.exit(
      checkRamBudget(
        budgetMib,
        { action: "startMachine", machine, machines },
        observe,
        heldMib
      )
    );

    expect(asked).toStrictEqual([
      machines.flatMap((held) => (held._tag === "found" ? [held.machine] : [])),
    ]);

    if (Exit.isSuccess(checked)) {
      return true;
    }

    const error = yield* Effect.flip(checked);

    expect(error._tag).toBe("Capacity");
    expect(error.message).toMatch(/^startMachine m0 needs \S+ of RAM, and /u);

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
  "another machine that boots, runs, can't be read or has no handle to read it by adds its RAM; one stopped, paused or missing adds none",
  {
    target: Ram,
    others: Schema.Array(Machine),
    extra: Machine,
    budget: Budget,
  },
  ({ target, others, extra, budget }) =>
    Effect.gen(function* () {
      const counts =
        extra.held !== "found" ||
        extra.state === "running" ||
        extra.state === "unknown";

      const before = yield* admits(target, others, budget);

      const after = yield* admits(
        target,
        [...others, extra],
        budget + (counts ? extra.ramMib : 0)
      );

      expect(after).toBe(before);
    })
);

it.effect.prop(
  "a parked base does not take a machine's share of the budget",
  {
    target: Ram,
    held: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_536 })),
    budget: Budget,
  },
  ({ target, held, budget }) =>
    Effect.gen(function* () {
      expect(yield* admits(target, [], budget, held)).toBe(
        target + held <= budget
      );
    })
);

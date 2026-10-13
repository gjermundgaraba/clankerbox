import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";
import { checkRamBudget } from "../src/ram-budget.ts";
import type { Held, MachineRef, Observed } from "../src/runtime.ts";

const Machine = Schema.Struct({
  ramMib: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
  booting: Schema.Boolean,
  state: Schema.Literals(["running", "stopped", "missing", "unknown"]),
});

const ref = (index: number, ramMib: number): MachineRef => ({
  id: `linux_m${index}`,
  name: `m${index}`,
  instance: index.toString(16).padStart(32, "0"),
  native: undefined,
  cpu: 1,
  ramMib,
  diskGib: 10,
  port: undefined,
});

type Placed = Held & { readonly state: Observed["state"] };

/** Whether `checkRamBudget` lets machine 0, booting, start among `others` under `budgetMib`. */
const admits = (target: number, others: ReadonlyArray<typeof Machine.Type>, budgetMib: number) =>
  Effect.gen(function* () {
    const machine = ref(0, target);

    const machines: ReadonlyArray<Placed> = [
      { machine, booting: true, state: "stopped" },
      ...others.map((other, index) => ({ ...other, machine: ref(index + 1, other.ramMib) })),
    ];

    const asked: Array<ReadonlyArray<MachineRef>> = [];

    const observe = (refs: ReadonlyArray<MachineRef>) =>
      Effect.sync(() => {
        asked.push(refs);

        return refs.map((asking) => ({
          state: machines.find((held) => held.machine.id === asking.id)?.state ?? "missing",
        }));
      });

    const checked = yield* Effect.exit(
      checkRamBudget(budgetMib, { action: "start", machine, machines }, observe),
    );

    expect(asked).toEqual([machines.flatMap((held) => (held.booting ? [] : [held.machine]))]);

    if (Exit.isSuccess(checked)) {
      return true;
    }

    const error = yield* Effect.flip(checked);

    expect(error._tag).toBe("Capacity");
    expect(error.message).toMatch(/^start linux_m0 needs \S+ of RAM, and /u);

    return false;
  });

const Ram = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 }));

const Budget = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262_144 }));

it.effect.prop(
  "alone, a boot is refused exactly when its own RAM passes the budget",
  { target: Ram, budget: Budget },
  ({ target, budget }) =>
    Effect.gen(function* () {
      expect(yield* admits(target, [], budget)).toBe(target <= budget);
    }),
);

it.effect.prop(
  "another machine that boots, runs or can't be read adds its RAM; one stopped or missing adds none",
  { target: Ram, others: Schema.Array(Machine), extra: Machine, budget: Budget },
  ({ target, others, extra, budget }) =>
    Effect.gen(function* () {
      const counts = extra.booting || extra.state === "running" || extra.state === "unknown";
      const before = yield* admits(target, others, budget);
      const after = yield* admits(target, [...others, extra], budget + (counts ? extra.ramMib : 0));

      expect(after).toBe(before);
    }),
);

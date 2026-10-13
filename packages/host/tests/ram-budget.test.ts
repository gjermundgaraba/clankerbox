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

it.effect.prop(
  "a boot is refused exactly when the booting and the running or unread machines' RAM passes the budget",
  {
    target: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
    others: Schema.Array(Machine),
    budget: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 262_144 })),
    nearUse: Schema.Boolean,
    slack: Schema.Int.check(Schema.isBetween({ minimum: -2, maximum: 2 })),
  },
  ({ target, others, budget, nearUse, slack }) =>
    Effect.gen(function* () {
      const machine = ref(0, target);

      const machines: ReadonlyArray<Held & { readonly state: Observed["state"] }> = [
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

      const used = machines
        .filter(({ booting, state }) => booting || state === "running" || state === "unknown")
        .reduce((sum, { machine: { ramMib } }) => sum + ramMib, 0);

      const budgetMib = nearUse ? Math.max(0, used + slack) : budget;

      const checked = yield* Effect.exit(
        checkRamBudget(budgetMib, { action: "start", machine, machines }, observe),
      );

      expect(asked).toEqual([machines.flatMap((held) => (held.booting ? [] : [held.machine]))]);

      if (used <= budgetMib) {
        expect(checked).toEqual(Exit.void);
      } else {
        const error = yield* Effect.flip(checked);

        expect(error._tag).toBe("Capacity");
        expect(error.message).toMatch(/^start linux_m0 needs \S+ of RAM, and /u);
      }
    }),
);

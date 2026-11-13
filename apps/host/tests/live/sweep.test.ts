import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { describe, it } from "@effect/vitest";
import { Duration, Effect, Schedule } from "effect";
import { expect } from "vite-plus/test";

import {
  ledgerOf as startLedger,
  ledgersIn,
  over,
  retired,
  retiredOver,
  selected,
  sweepRead,
  thisHost,
} from "./sweep.ts";
import type { Ledger, Reading } from "./sweep.ts";

interface Machine {
  readonly id: string;
  readonly run?: string;
}

interface Copy {
  readonly key: string;
  readonly source?: string;
}

const run = "0live-aaaa";

const ledgerOf = (
  of: string,
  entries: Partial<Pick<Ledger, "copies" | "sources" | "hostname">> = {}
): Ledger => ({
  run: of,
  hostname: entries.hostname ?? "here",
  pid: 7,
  copies: entries.copies ?? new Set(),
  sources: entries.sources ?? new Set(),
});

const reading = (
  ledgers: readonly Ledger[],
  isOver: (ledger: Ledger) => boolean = () => false,
  named: ReadonlySet<string> = new Set()
): Reading<Machine, Copy> => ({
  run,
  ledgers,
  over: isOver,
  named,
  runOf: (machine) => machine.run,
  idOf: (machine) => machine.id,
  keyOf: (copy) => copy.key,
  sourceOf: (copy) => copy.source,
});

describe("the live suites' sweep", () => {
  it("never selects a machine by a ledger's ID, only by its run's mark", () => {
    const unmarked = { id: "m-1" };
    const mine = { id: "m-2", run };

    const { swept, listed } = selected(
      { machines: [unmarked, mine], copies: [] },
      reading([ledgerOf(run, { sources: new Set(["m-1"]) })])
    );

    expect(swept.machines).toStrictEqual([mine]);
    expect(listed.machines).toStrictEqual([]);
  });

  it("lists another run's marked machines and copies, and deletes none of them", () => {
    const theirs = { id: "m-3", run: "0live-bbbb" };
    const saved = { key: "cbx-1" };
    const ofTheirs = { key: "cbx-2", source: "m-3" };

    const { swept, listed } = selected(
      { machines: [theirs], copies: [saved, ofTheirs] },
      reading([ledgerOf("0live-bbbb", { copies: new Set(["cbx-1"]) })])
    );

    expect(swept).toStrictEqual({ machines: [], copies: [] });
    expect(listed).toStrictEqual({
      machines: [theirs],
      copies: [saved, ofTheirs],
    });
  });

  it("deletes what a run provably over left, by its mark and its ledger", () => {
    const theirs = { id: "m-4", run: "0live-cccc" };
    const saved = { key: "cbx-3" };
    const named = { id: "m-5", run: "0live-dddd" };

    const { swept, listed } = selected(
      { machines: [theirs, named], copies: [saved] },
      reading(
        [ledgerOf("0live-cccc", { copies: new Set(["cbx-3"]) })],
        (ledger) => ledger.run === "0live-cccc",
        new Set(["0live-dddd"])
      )
    );

    expect(swept).toStrictEqual({
      machines: [theirs, named],
      copies: [saved],
    });
    expect(listed).toStrictEqual({ machines: [], copies: [] });
  });

  it("deletes a copy only through the run's ledger or a machine its mark covers", () => {
    const mine = { id: "m-6", run };
    const ledgered = { key: "cbx-4" };
    const ofMine = { key: "cbx-5", source: "m-6" };
    const ofAGoneMachine = { key: "cbx-6", source: "m-7" };
    const ofAHost = { key: "cbx-7", source: "m-8" };
    const unknown = { key: "cbx-8" };

    const { swept, listed } = selected(
      {
        machines: [mine, { id: "m-8" }],
        copies: [ledgered, ofMine, ofAGoneMachine, ofAHost, unknown],
      },
      reading([
        ledgerOf(run, {
          copies: new Set(["cbx-4"]),
          sources: new Set(["m-7"]),
        }),
      ])
    );

    expect(swept).toStrictEqual({
      machines: [mine],
      copies: [ledgered, ofMine, ofAGoneMachine],
    });
    expect(listed).toStrictEqual({ machines: [], copies: [] });
  });
});

describe("a live run's ledger", () => {
  it("is over only once its process is gone from this host", () => {
    const ledger = ledgerOf("0live-eeee", { hostname: "here" });

    expect([
      over(ledger, { hostname: "here", alive: () => false }),
      over(ledger, { hostname: "here", alive: () => true }),
      over(ledger, { hostname: "elsewhere", alive: () => false }),
      over(
        { ...ledger, pid: Number.NaN },
        { hostname: "here", alive: () => false }
      ),
    ]).toStrictEqual([true, false, false, false]);
  });

  it("is kept in a folder and a file of the user's alone, and refused once open to others", () => {
    const dir = path.join(
      mkdtempSync(path.join(tmpdir(), "live-ledger-")),
      "ledgers"
    );

    const writer = startLedger(dir, "boat", run);

    writer.copy("cbx-9");
    writer.source("m-9");

    expect([
      statSync(dir).mode & 0o777,
      statSync(path.join(dir, `boat-${run}.ledger`)).mode & 0o777,
    ]).toStrictEqual([0o700, 0o600]);

    const [read] = ledgersIn(dir, "boat");

    expect([
      read?.run,
      [...(read?.copies ?? [])],
      [...(read?.sources ?? [])],
    ]).toStrictEqual([run, ["cbx-9"], ["m-9"]]);

    chmodSync(path.join(dir, `boat-${run}.ledger`), 0o640);

    expect(() => ledgersIn(dir, "boat")).toThrow(/chmod 600/u);

    retired(dir, "boat", run);

    expect(ledgersIn(dir, "boat")).toStrictEqual([]);
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});

describe("a sweep's reading of the runs that are over", () => {
  it.effect(
    "reads the ledgers before the account, and ends only those of the runs it read over, so a run that ends meanwhile keeps its ledger",
    () =>
      Effect.gen(function* () {
        const dir = path.join(
          mkdtempSync(path.join(tmpdir(), "live-ledger-")),
          "ledgers"
        );

        const mine = startLedger(dir, "boat", run);
        const ending = "0live-bbbb";
        const ended = "0live-cccc";
        const gone = new Set([102]);

        mine.ledgers();

        for (const [each, pid] of [
          [ending, 101],
          [ended, 102],
        ] as const) {
          writeFileSync(
            path.join(dir, `boat-${each}.ledger`),
            `run ${each} ${hostname()} ${pid}\n`,
            { mode: 0o600 }
          );
        }

        const selection = yield* sweepRead(
          mine.ledgers,
          Effect.sync(() => {
            gone.add(101);

            return {
              machines: [{ id: "m-10", run: ending }],
              copies: [],
            };
          }),
          {
            ...reading([]),
            over: (ledger) =>
              over(ledger, {
                hostname: hostname(),
                alive: (pid) => !gone.has(pid),
              }),
          }
        );

        retiredOver(dir, "boat", selection);

        expect([...selection.over]).toStrictEqual([ended]);
        expect(selection.listed.machines).toStrictEqual([
          { id: "m-10", run: ending },
        ]);
        expect(
          ledgersIn(dir, "boat")
            .map((ledger) => ledger.run)
            .toSorted()
        ).toStrictEqual([run, ending]);
        rmSync(path.dirname(dir), { recursive: true, force: true });
      })
  );
});

describe("a live run killed before it makes anything", () => {
  it.live(
    "leaves a ledger its first sweep began, over once its process is gone, so the next run's sweep takes what it made",
    () =>
      Effect.gen(function* () {
        const dir = path.join(
          mkdtempSync(path.join(tmpdir(), "live-ledger-")),
          "ledgers"
        );

        const killed = "0live-dead";
        const sweep = new URL("sweep.ts", import.meta.url).href;

        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import { ledgerOf } from ${JSON.stringify(sweep)}; ledgerOf(${JSON.stringify(dir)}, "boat", ${JSON.stringify(killed)}).ledgers(); setInterval(() => {}, 60_000);`,
          ],
          { stdio: "ignore" }
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            child.kill("SIGKILL");
            rmSync(path.dirname(dir), { recursive: true, force: true });
          })
        );

        const exited: Promise<unknown> = once(child, "exit");

        const begun = yield* Effect.repeat(
          Effect.sync(() =>
            existsSync(path.join(dir, `boat-${killed}.ledger`))
          ),
          {
            until: (written) => written || child.exitCode !== null,
            schedule: Schedule.spaced(Duration.millis(20)),
          }
        ).pipe(Effect.timeout(Duration.seconds(4)));

        const running = ledgersIn(dir, "boat").find(
          (each) => each.run === killed
        );

        expect(running !== undefined && over(running, thisHost)).toBe(false);

        child.kill("SIGKILL");

        yield* Effect.promise(async () => await exited);

        expect([begun, child.signalCode]).toStrictEqual([true, "SIGKILL"]);

        const ledgers = startLedger(dir, "boat", run).ledgers();
        const left = ledgers.find((each) => each.run === killed);

        expect([
          left?.pid,
          left !== undefined && over(left, thisHost),
        ]).toStrictEqual([child.pid, true]);

        const { swept } = selected(
          { machines: [{ id: "sandbox-1", run: killed }], copies: [] },
          { ...reading(ledgers), over: (each) => over(each, thisHost) }
        );

        expect(swept.machines).toStrictEqual([
          { id: "sandbox-1", run: killed },
        ]);
      }).pipe(Effect.scoped)
  );
});

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

import { Effect, Predicate } from "effect";

import { liveRun } from "./marks.ts";

/** What a live run made that can carry no mark, written as it makes it, and who made it. */
export interface Ledger {
  readonly run: string;
  readonly hostname: string;
  readonly pid: number;
  /** boat snapshots by name, or smol cloud checkpoints by ID. */
  readonly copies: ReadonlySet<string>;
  /** The IDs of the run's machines, which find their copies once they are gone, and nothing else. */
  readonly sources: ReadonlySet<string>;
}

export interface Found<M, C> {
  readonly machines: readonly M[];
  readonly copies: readonly C[];
}

export interface Reading<M, C> {
  readonly run: string;
  readonly ledgers: readonly Ledger[];
  readonly over: (ledger: Ledger) => boolean;
  /** Runs the operator names as over, by `CLANKERBOX_LIVE_OVER`. */
  readonly named: ReadonlySet<string>;
  /** The run mark a machine carries, or undefined for one no live run made. */
  readonly runOf: (machine: M) => string | undefined;
  readonly idOf: (machine: M) => string;
  readonly keyOf: (copy: C) => string;
  readonly sourceOf: (copy: C) => string | undefined;
}

export interface Selection<M, C> {
  /** What the sweep deletes: this run's, and that of each run provably over. */
  readonly swept: Found<M, C>;
  /** What other live runs hold, which the sweep only lists. */
  readonly listed: Found<M, C>;
  /** The other runs this reading took as over, whose ledgers go once nothing is left to sweep. */
  readonly over: ReadonlySet<string>;
}

const copiesBy = <M, C>(
  reading: Reading<M, C>,
  ledgers: readonly Ledger[],
  machines: readonly M[]
) => {
  const keys = new Set(ledgers.flatMap((ledger) => [...ledger.copies]));

  const sources = new Set([
    ...ledgers.flatMap((ledger) => [...ledger.sources]),
    ...machines.map(reading.idOf),
  ]);

  return (copy: C) => {
    const source = reading.sourceOf(copy);

    return (
      keys.has(reading.keyOf(copy)) ||
      (source !== undefined && sources.has(source))
    );
  };
};

export const selected = <M, C>(
  found: Found<M, C>,
  reading: Reading<M, C>
): Selection<M, C> => {
  const over = new Set(
    [
      ...reading.named,
      ...reading.ledgers.filter(reading.over).map((ledger) => ledger.run),
    ].filter((run) => run !== reading.run)
  );

  const runs = new Set([reading.run, ...over]);

  const ofRun = (machine: M, swept: boolean) => {
    const run = reading.runOf(machine);

    return run !== undefined && runs.has(run) === swept;
  };

  const sweptMachines = found.machines.filter((machine) =>
    ofRun(machine, true)
  );

  const listedMachines = found.machines.filter((machine) =>
    ofRun(machine, false)
  );

  const sweptCopy = copiesBy(
    reading,
    reading.ledgers.filter((ledger) => runs.has(ledger.run)),
    sweptMachines
  );

  const listedCopy = copiesBy(
    reading,
    reading.ledgers.filter((ledger) => !runs.has(ledger.run)),
    listedMachines
  );

  return {
    swept: {
      machines: sweptMachines,
      copies: found.copies.filter(sweptCopy),
    },
    listed: {
      machines: listedMachines,
      copies: found.copies.filter(
        (copy) => !sweptCopy(copy) && listedCopy(copy)
      ),
    },
    over,
  };
};

/**
 * Reads the ledgers, and which of their runs are over, before what the account holds, so a run read
 * as over had made all it left before the listing began, and selects from the two.
 */
export const sweepRead = <M, C, E, R>(
  ledgers: () => readonly Ledger[],
  listing: Effect.Effect<Found<M, C>, E, R>,
  reading: Omit<Reading<M, C>, "ledgers">
): Effect.Effect<Selection<M, C>, E, R> =>
  Effect.flatMap(
    Effect.sync(() => {
      const read = ledgers();
      const ended = new Set(read.filter(reading.over).map(({ run }) => run));

      return { read, ended };
    }),
    ({ read, ended }) =>
      Effect.map(listing, (found) =>
        selected(found, {
          ...reading,
          ledgers: read,
          over: ({ run }) => ended.has(run),
        })
      )
  );

/** The live runs' ledgers: a folder of the user's own, never the shared temporary one. */
export const liveLedgers =
  process.env["CLANKERBOX_LIVE_LEDGERS"] ??
  path.join(
    process.env["XDG_STATE_HOME"] ?? path.join(homedir(), ".local", "state"),
    "clankerbox-live"
  );

/** Runs the operator names as over, comma-separated in `CLANKERBOX_LIVE_OVER`. */
export const namedOver: ReadonlySet<string> = new Set(
  (process.env["CLANKERBOX_LIVE_OVER"] ?? "").split(",").filter(liveRun)
);

/** Whether the sweep only lists what it would delete, by `CLANKERBOX_LIVE_LIST_ONLY=1`. */
export const listOnly = process.env["CLANKERBOX_LIVE_LIST_ONLY"] === "1";

const privateTo = (file: string, mends: string) => {
  const mode = statSync(file).mode & 0o777;

  if ((mode & 0o077) !== 0) {
    throw new Error(
      `the live ledger ${file} has mode ${mode.toString(8)}, open to others: ${mends}`
    );
  }
};

/** Makes `dir` a folder of the user's alone, refusing one found open to others. */
export const privateFolder = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateTo(dir, "chmod 700 it");
};

const fileOf = (dir: string, suite: string, run: string) =>
  path.join(dir, `${suite}-${run}.ledger`);

const parsed = (file: string): Ledger => {
  const [head = "", ...lines] = readFileSync(file, "utf8").split("\n");
  const [noun, run, host, pid] = head.split(" ");

  if (noun !== "run" || !liveRun(run) || host === undefined) {
    throw new Error(
      `the live ledger ${file} names no run on its first line: read it, then delete what it lists and it`
    );
  }

  const entries = (kind: string) =>
    new Set(
      lines.flatMap((line) => {
        const [what, value] = line.split(" ");

        return what === kind && value !== undefined && value !== ""
          ? [value]
          : [];
      })
    );

  return {
    run: run ?? "",
    hostname: host,
    pid: Number(pid),
    copies: entries("copy"),
    sources: entries("source"),
  };
};

/** Every run's ledger of `suite`, each refused when it is open to others. */
export const ledgersIn = (dir: string, suite: string): readonly Ledger[] => {
  if (!existsSync(dir)) {
    return [];
  }

  privateTo(dir, "chmod 700 it");

  return readdirSync(dir)
    .filter((name) => name.startsWith(`${suite}-`) && name.endsWith(".ledger"))
    .map((name) => {
      const file = path.join(dir, name);

      privateTo(file, "chmod 600 it");

      return parsed(file);
    });
};

export interface Writer {
  /** Every run's ledger of the suite, this run's begun first, so a run its first sweep reads is one a later run can tell is over. */
  readonly ledgers: () => readonly Ledger[];
  readonly copy: (key: string) => void;
  readonly source: (id: string) => void;
}

/**
 * Starts this run's ledger, which says the host and process that run it, so a later run can tell it
 * is over only while that process is gone from this host.
 */
export const ledgerOf = (dir: string, suite: string, run: string): Writer => {
  const file = fileOf(dir, suite, run);

  const begun = () => {
    privateFolder(dir);

    if (!existsSync(file)) {
      writeFileSync(file, `run ${run} ${hostname()} ${process.pid}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    }
  };

  const written = (line: string) => {
    begun();
    appendFileSync(file, `${line}\n`);
  };

  return {
    ledgers: () => {
      begun();

      return ledgersIn(dir, suite);
    },
    copy: (key) => {
      written(`copy ${key}`);
    },
    source: (id) => {
      written(`source ${id}`);
    },
  };
};

/** Ends a run's ledger once nothing it lists is left. */
export const retired = (dir: string, suite: string, run: string) => {
  rmSync(fileOf(dir, suite, run), { force: true });
};

/**
 * Ends the ledgers of the runs `selection` read as over once it left nothing to sweep, and no other:
 * a run that ended after the reading had its resources only listed.
 */
export const retiredOver = <M, C>(
  dir: string,
  suite: string,
  selection: Selection<M, C>
) => {
  if (
    selection.swept.machines.length > 0 ||
    selection.swept.copies.length > 0
  ) {
    return;
  }

  for (const run of selection.over) {
    retired(dir, suite, run);
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !(Predicate.hasProperty(error, "code") && error.code === "ESRCH");
  }
};

export interface Here {
  readonly hostname: string;
  readonly alive: (pid: number) => boolean;
}

export const thisHost: Here = { hostname: hostname(), alive };

/**
 * Whether the run of a ledger is provably over: its process, on this host, is gone. A ledger of
 * another host, or a PID reused since, reads as a run that may still be going.
 */
export const over = (ledger: Ledger, from: Here): boolean =>
  ledger.hostname === from.hostname &&
  Number.isInteger(ledger.pid) &&
  ledger.pid > 0 &&
  !from.alive(ledger.pid);

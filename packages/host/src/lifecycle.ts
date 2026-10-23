import type {
  Declared,
  Invalid,
  Phase,
  Setup,
  Superseded,
  TailnetStatus,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  createEffectActor,
  createEffectLogic,
  type EffectActor,
  send,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import { Effect, type Scope } from "effect";
import { type SnapshotFrom, types } from "xstate";
import { type Decided, next } from "./reconcile.ts";
import type { MachineState, RuntimeError } from "./runtime.ts";
import type { CheckpointRecord, Desire, Intent } from "./store.ts";

/** What a step fails with: what a request that waits on the steps answers, short of its own checks. */
export type StepError = Exclude<Declared<"startMachine">, Invalid | Superseded>;

/**
 * Where a new machine's disk comes from, as the request that creates it read it: its base's
 * image, a checkpoint, or another machine, whose `instance` the copy checks again.
 */
export type Source =
  | { readonly kind: "base"; readonly image: string }
  | { readonly kind: "checkpoint"; readonly record: CheckpointRecord }
  | { readonly kind: "machine"; readonly from: Intent };

/** What only the request that creates a machine holds, and only in memory: a setup can carry secrets. */
export interface Making {
  readonly source: Source;
  readonly script: Setup | undefined;
}

/** A machine's actor's context: what it tracks of its row, and what only memory holds. */
export interface Life extends Decided {
  readonly name: string;
  readonly generation: number;
  /** Dropped once the machine is made, or its making failed. */
  readonly making: Making | undefined;
  readonly seen: MachineState;
  /** Why the last step failed, until the next request. */
  readonly error: StepError | undefined;
  /** Why the machine is being deleted though no request asked: what failed before it was made. */
  readonly undone: StepError | undefined;
  readonly tailnet: TailnetCheck;
}

/**
 * A machine's place on the tailnet, as this host last checked it since the machine started, and
 * when to check again: never stored, as each start checks again, and shown only while the runtime
 * reads the machine running. A check starts `tailscaled` if it isn't running and joins it if it
 * isn't signed in.
 */
export interface TailnetCheck {
  /** What the last check found: `undefined` before the first, or on a host that joins no tailnet. */
  readonly status: TailnetStatus | undefined;
  /** Rechecks to wait before the next check, while the machine runs: `undefined` for none. */
  readonly wait: number | undefined;
  /** Rechecks the next failure waits: doubling with each failure in a row, up to `longestBackoff`. */
  readonly backoff: number;
}

/** What a new actor starts from: its row, what its create holds, and what the runtime last read. */
export type Born = Pick<Life, "name" | "desired" | "generation" | "made" | "making" | "seen">;

/** A step's error, with the generation it worked for: a later request makes it no answer. */
export interface Failure {
  readonly error: StepError;
  readonly generation: number;
}

/**
 * The runtime work of each phase. A step reads the machine's row and writes its progress there; a
 * step that changes the machine owns its lease for as long as it runs, and a read shares it, so a
 * step cut short by a request ends before anything reads or changes the machine again.
 */
export interface Steps {
  /** A runtime that can't be read reads `unknown`. */
  readonly observe: (life: Life) => Effect.Effect<MachineState>;
  /** Copies the machine's disk and runs its setup: a machine is made by one step or none. */
  readonly make: (life: Life) => Effect.Effect<void, StepError>;
  /** Starts the machine, also when it runs already, and prepares it. */
  readonly start: (life: Life) => Effect.Effect<void, StepError>;
  /**
   * Checks a running machine's place on the host's tailnet, and joins it if it isn't: `undefined`
   * on a host that joins no tailnet, and a failure is a status, which no request answers.
   */
  readonly join: (life: Life) => Effect.Effect<TailnetStatus | undefined>;
  readonly stop: (life: Life) => Effect.Effect<void, StepError>;
  /** Saves a running machine's execution and stops its VM. */
  readonly pause: (life: Life) => Effect.Effect<void, StepError>;
  readonly remove: (life: Life) => Effect.Effect<void, RuntimeError>;
}

const phases = {
  observing: "observing",
  deciding: "observing",
  waiting: "waiting",
  creating: "creating",
  starting: "starting",
  stopping: "stopping",
  pausing: "pausing",
  joining: "settled",
  deleting: "deleting",
  removed: "deleting",
  settled: "settled",
  failed: "failed",
  lost: "lost",
} satisfies Record<Snapshot["value"], Phase>;

export const phaseOf = (snapshot: Snapshot): Phase => phases[snapshot.value];

const joinedWait = 60;

export const longestBackoff = 64;

const unchecked: TailnetCheck = { status: undefined, wait: undefined, backoff: 1 };

export const checked = (check: TailnetCheck, status: TailnetStatus | undefined): TailnetCheck => {
  if (status?.state === "joined") {
    return { status, wait: joinedWait, backoff: 1 };
  }

  if (status?.state === "failed") {
    return {
      status,
      wait: check.backoff,
      backoff: Math.min(check.backoff * 2, longestBackoff),
    };
  }

  return { ...unchecked, status };
};

const ticked = (check: TailnetCheck): TailnetCheck =>
  check.wait === undefined || check.wait === 0 ? check : { ...check, wait: check.wait - 1 };

const decide = (life: Life) => {
  const target = next(life, life.seen);

  return target === "settled" && life.seen === "running" && life.tailnet.wait === 0
    ? "joining"
    : target;
};

export const wanted = (life: Life, desire: Desire): Life => {
  if (desire.generation <= life.generation) {
    return life;
  }

  if (life.desired === "deleted") {
    return { ...life, generation: desire.generation, error: undefined };
  }

  return {
    ...life,
    desired: desire.desired,
    generation: desire.generation,
    prepared: desire.desired === "running" ? false : life.prepared,
    error: undefined,
  };
};

const failing = (life: Life, failure: Failure) => {
  const after = { ...life, making: undefined };

  if (life.desired !== "deleted" && !life.made) {
    return {
      target: "deleting" as const,
      context: { ...after, desired: "deleted" as const, undone: failure.error },
    };
  }

  return failure.generation < life.generation
    ? { target: "observing" as const, context: after }
    : { target: "failed" as const, context: { ...after, error: failure.error } };
};

const interrupting = (life: Life, desire: Desire) => {
  const after = wanted(life, desire);

  return after.desired === life.desired
    ? { context: after }
    : { target: "observing" as const, context: after };
};

const cutting = (life: Life, desire: Desire) => {
  const after = wanted(life, desire);

  return after.desired === "deleted"
    ? { target: "deleting" as const, context: { ...after, making: undefined } }
    : { context: after };
};

const again = (life: Life, desire: Desire) => ({
  target: "observing" as const,
  context: wanted(life, desire),
});

const reread = (life: Life, seen: MachineState) => ({
  target: "deciding" as const,
  context: { ...life, seen },
});

export const lifecycle = (steps: Steps) => {
  const step =
    <A>(run: (life: Life) => Effect.Effect<A, StepError>) =>
    ({ input }: { input: Life }) =>
      Effect.mapError(run(input), (error): Failure => ({ error, generation: input.generation }));

  const setup = setupEffect({
    schemas: {
      input: types<Born>(),
      context: types<Life>(),
      events: { desire: types<Desire>(), seen: types<{ readonly seen: MachineState }>() },
      tags: types<"resting">(),
    },
    actors: {
      observe: createEffectLogic(({ input }: { input: Life }) => steps.observe(input)),
      make: createEffectLogic(step(steps.make)),
      start: createEffectLogic(step(steps.start)),
      join: createEffectLogic(({ input }: { input: Life }) => steps.join(input)),
      stop: createEffectLogic(step(steps.stop)),
      pause: createEffectLogic(step(steps.pause)),
      remove: createEffectLogic(step(steps.remove)),
    },
  });

  const resting = setup.createStateConfig({
    tags: ["resting"],
    on: {
      desire: ({ context, event }) => again(context, event),
      seen: ({ context, event }) => reread(context, event.seen),
    },
  });

  const settled = setup.createStateConfig({
    tags: ["resting"],
    on: {
      desire: ({ context, event }) => again(context, event),
      seen: ({ context, event }) =>
        reread({ ...context, tailnet: ticked(context.tailnet) }, event.seen),
    },
  });

  const stepping = (
    src: "make" | "start" | "stop" | "pause",
    desired: (life: Life, desire: Desire) => { readonly context: Life },
    reached: Partial<Life>,
  ) =>
    setup.createStateConfig({
      invoke: {
        src,
        input: ({ context }) => context,
        onDone: ({ context }) => ({ target: "observing", context: { ...context, ...reached } }),
        onError: ({ context, event }) => failing(context, event.error),
      },
      on: { desire: ({ context, event }) => desired(context, event) },
    });

  return setup.createMachine({
    id: "machine",
    context: ({ input }) => ({
      ...input,
      prepared: false,
      error: undefined,
      undone: undefined,
      tailnet: unchecked,
    }),
    initial: "deciding",
    on: {
      desire: ({ context, event }) => ({ context: wanted(context, event) }),
    },
    states: {
      observing: {
        invoke: {
          src: "observe",
          input: ({ context }) => context,
          onDone: ({ context, event }) => reread(context, event.output),
        },
      },
      deciding: {
        type: "choice",
        choice: ({ context }) => ({ target: decide(context) }),
      },
      waiting: resting,
      settled,
      joining: {
        tags: ["resting"],
        invoke: {
          src: "join",
          input: ({ context }) => context,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, tailnet: checked(context.tailnet, event.output) },
          }),
        },
        on: {
          desire: ({ context, event }) => again(context, event),
          seen: ({ context, event }) =>
            event.seen === "running" || event.seen === "unknown" ? {} : reread(context, event.seen),
        },
      },
      failed: {
        tags: ["resting"],
        on: {
          desire: ({ context, event }) => again(context, event),
          seen: ({ context, event }) =>
            context.desired === "deleted" ? reread(context, event.seen) : {},
        },
      },
      lost: resting,
      creating: stepping("make", cutting, { made: true, making: undefined, prepared: false }),
      starting: stepping("start", interrupting, {
        prepared: true,
        tailnet: { ...unchecked, wait: 0 },
      }),
      stopping: stepping("stop", interrupting, { prepared: false }),
      pausing: stepping("pause", interrupting, { prepared: false }),
      deleting: {
        invoke: {
          src: "remove",
          input: ({ context }) => context,
          onDone: { target: "removed" },
          onError: ({ context, event }) => failing(context, event.error),
        },
      },
      removed: { type: "final" },
    },
  });
};

export type Lifecycle = ReturnType<typeof lifecycle>;

export type MachineActor = EffectActor<Lifecycle>;

export type Snapshot = SnapshotFrom<Lifecycle>;

export const spawn = (
  logic: Lifecycle,
  born: Born,
): Effect.Effect<MachineActor, never, Scope.Scope> => createEffectActor(logic, { input: born });

export const ask = (actor: MachineActor, desire: Desire): Effect.Effect<void> =>
  send(actor, { type: "desire", ...desire });

export const tell = (actor: MachineActor, seen: MachineState): Effect.Effect<void> =>
  send(actor, { type: "seen", seen });

export const isResting = (snapshot: Snapshot): boolean => snapshot.hasTag("resting");

export const answer = (actor: MachineActor, generation: number): Effect.Effect<Snapshot> =>
  waitFor(
    actor,
    (snapshot) =>
      snapshot.status !== "active" ||
      (isResting(snapshot) && snapshot.context.generation >= generation),
  ).pipe(Effect.catch(() => Effect.sync(() => actor.getSnapshot())));

export const removal = (actor: MachineActor): Effect.Effect<void> =>
  waitFor(actor, (snapshot) => snapshot.status !== "active").pipe(Effect.ignore);

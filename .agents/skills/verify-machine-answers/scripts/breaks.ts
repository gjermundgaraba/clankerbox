import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface Break {
  readonly name: string;
  readonly config: "TwoClients.cfg" | "MachineAnswers.cfg" | "Drifting.cfg";
  readonly file: string;
  readonly edits: ReadonlyArray<readonly [find: string, put: string]>;
  readonly violated: string;
}

const root = path.resolve(import.meta.dirname, "../../../..");

const skill = ".agents/skills/verify-machine-answers";

const chart = "apps/server/src/machine-chart.ts";

const answers = `${skill}/model/MachineAnswers.tla`;

const copied = [
  "apps/server/src/chart.ts",
  chart,
  "apps/server/tests/chart-rows.ts",
  answers,
  `${skill}/model/MachineAnswers.cfg`,
  `${skill}/model/TwoClients.cfg`,
  `${skill}/model/Drifting.cfg`,
  `${skill}/scripts/export-chart.ts`,
];

const breaks: readonly Break[] = [
  {
    name: "ask-keeps-rest",
    config: "TwoClients.cfg",
    file: chart,
    edits: [
      [
        `        ask: (args) => ({
          target: "#machine.made.observing",
          context: asked(args),
        }),
        resize:`,
        `        ask: (args) => ({ context: asked(args) }),
        resize:`,
      ],
    ],
    violated: "RestTrue",
  },
  {
    name: "start-rests",
    config: "TwoClients.cfg",
    file: chart,
    edits: [
      [
        `      target: "#machine.made.observing",
      context: {
        ...told(context, event),
        ...(event.status === "done" ? done : {}),`,
        `      target:
        event.status === "done" && done.prepared
          ? "#machine.made.settled"
          : "#machine.made.observing",
      context: {
        ...told(context, event),
        ...(event.status === "done" ? done : {}),`,
      ],
    ],
    violated: "RestTrue",
  },
  {
    name: "prepared-make-rests",
    config: "TwoClients.cfg",
    file: chart,
    edits: [
      [
        `                    target: "#machine.made.observing",
                    context: {
                      ...told(context, event),
                      prepared: event.outcome.prepared === true,`,
        `                    target:
                      event.outcome.prepared === true
                        ? "#machine.made.settled"
                        : "#machine.made.observing",
                    context: {
                      ...told(context, event),
                      prepared: event.outcome.prepared === true,`,
      ],
    ],
    violated: "RestTrue",
  },
  {
    name: "skip-undo",
    config: "MachineAnswers.cfg",
    file: chart,
    edits: [
      [
        `                : {
                    target: "#machine.undoing.due",
                    context: { ...told(context, event), error: event.error },`,
        `                : {
                    target: "#machine.undone",
                    context: { ...told(context, event), error: event.error },`,
      ],
    ],
    violated: "NoOrphan",
  },
  {
    name: "silent-failure",
    config: "MachineAnswers.cfg",
    file: chart,
    edits: [
      [
        `        context: { ...told(context, event), error: event.error },
      } as const;`,
        `        context: told(context, event),
      } as const;`,
      ],
    ],
    violated: "FailedSays",
  },
  {
    name: "read-fails-rests",
    config: "MachineAnswers.cfg",
    file: chart,
    edits: [
      [
        `  if (seen === "unknown") {
    return;
  }`,
        `  if (seen === "unknown") {
    return { target: "#machine.made.settled" } as const;
  }`,
      ],
    ],
    violated: "RestTrue",
  },
  {
    name: "report-enters-step",
    config: "TwoClients.cfg",
    file: chart,
    edits: [
      [
        `({ target: "due", context: told(context, event) }) as const`,
        `({ target: "sent", context: told(context, event) }) as const`,
      ],
    ],
    violated: "OpIsState",
  },
  {
    name: "no-overtaken",
    config: "MachineAnswers.cfg",
    file: chart,
    edits: [
      [
        `      event.status === "failed" &&
      wants(kind, context.desired) &&
      context.resize === undefined`,
        `      event.status === "failed" &&
      context.resize === undefined`,
      ],
    ],
    violated: "nothing",
  },
  {
    name: "stop-keeps-prepared",
    config: "MachineAnswers.cfg",
    file: chart,
    edits: [
      [
        `on: { reported: ended("stop", { prepared: false }) },`,
        `on: { reported: ended("stop", {}) },`,
      ],
    ],
    violated: "nothing",
  },
  {
    name: "no-fence",
    config: "TwoClients.cfg",
    file: answers,
    edits: [
      [
        `       /\\ IF m.boot = boot /\\ m.id > high
          THEN /\\ high' = m.id`,
        `       /\\ IF TRUE
          THEN /\\ high' = m.id`,
      ],
      [
        `       /\\ m.boot = boot /\\ m.id > high
       /\\ high' = m.id`,
        `       /\\ high' = m.id`,
      ],
    ],
    violated: "OnceOnly",
  },
  {
    name: "answers-unrested",
    config: "TwoClients.cfg",
    file: answers,
    edits: [
      [
        `     ELSE /\\ row.op.id = 0 \\/ Shown = "waiting"
          /\\ Shown \\in Resting \\cup {"waiting"}
          /\\ IF cl[k].d = "deleted"`,
        `     ELSE /\\ IF cl[k].d = "deleted"`,
      ],
    ],
    violated: "AnswerTrue",
  },
  {
    name: "superseded-names-own",
    config: "TwoClients.cfg",
    file: answers,
    edits: [
      [
        `THEN Finish(k, "superseded", row.desired)`,
        `THEN Finish(k, "superseded", cl[k].d)`,
      ],
    ],
    violated: "SupersededHonest",
  },
  {
    name: "make-never-given-up",
    config: "MachineAnswers.cfg",
    file: answers,
    edits: [
      [
        `        \\/ /\\ ~held
           /\\ boot # row.op.boot`,
        `        \\/ /\\ ~held /\\ row.op.kind # "make"
           /\\ boot # row.op.boot`,
      ],
    ],
    violated: "deadlock",
  },
  {
    name: "restart-unnoticed",
    config: "MachineAnswers.cfg",
    file: answers,
    edits: [
      [
        `/\\ boot # row.op.boot \\/ (id > high /\\ ~CanSend(row))`,
        `/\\ id > high /\\ ~CanSend(row)`,
      ],
    ],
    violated: "AllAnswered",
  },
  {
    name: "no-sweep",
    config: "Drifting.cfg",
    file: answers,
    edits: [
      [
        `Sweep ==
  /\\ linked`,
        `Sweep ==
  /\\ FALSE /\\ linked`,
      ],
    ],
    violated: "EventuallyNoOrphan",
  },
  {
    name: "sweep-unclaimed",
    config: "TwoClients.cfg",
    file: answers,
    edits: [
      [
        `Retired == cl[Creator].pc # "idle" /\\ row.state`,
        `Retired == row.state`,
      ],
    ],
    violated: "RestTrue",
  },
  {
    name: "drift-ignored",
    config: "Drifting.cfg",
    file: answers,
    edits: [
      [
        `/\\ \\E v \\in (IF linked THEN {vm} ELSE {"unknown"})`,
        `/\\ \\E v \\in (IF linked
               THEN {IF Phase(row) = "settled" THEN row.desired ELSE vm}
               ELSE {"unknown"})`,
      ],
    ],
    violated: "RunsWhenWanted",
  },
  {
    name: "repeated-ask-rests",
    config: "Drifting.cfg",
    file: chart,
    edits: [
      [
        `        ask: (args) => ({
          target: "#machine.made.observing",
          context: asked(args),
        }),
        resize:`,
        `        ask: (args) =>
          args.event.desired === args.context.desired
            ? { context: asked(args) }
            : { target: "#machine.made.observing", context: asked(args) },
        resize:`,
      ],
    ],
    violated: "AnswerTrue",
  },
  {
    name: "drift-fails",
    config: "Drifting.cfg",
    file: chart,
    edits: [
      [
        `      ? ({
          target: "#machine.made.stepping.starting",
          context: { pin },
        } as const)`,
        `      ? ({
          target: "#machine.made.failed",
          context: { pin, error: { _tag: "Internal", message: "drifted" } as never },
        } as const)`,
      ],
    ],
    violated: "RunsWhenWanted",
  },
];

const broken = (text: string, { name, edits }: Break) => {
  let mutated = text;

  for (const [find, put] of edits) {
    if (!mutated.includes(find)) {
      throw new Error(`${name} can't find what it breaks:\n${find}`);
    }

    mutated = mutated.replace(find, put);
  }

  return mutated;
};

const verdicts = new Map<number | null, string>([
  [0, "nothing"],
  [11, "deadlock"],
]);

const verdictOf = (status: number | null, output: string) => {
  const violated =
    /(?:Invariant|Temporal property) (?<name>\w+) (?:is|was) violated/u.exec(
      output
    )?.groups;

  return violated?.["name"] ?? verdicts.get(status) ?? "broken";
};

const run = (taken: Break) => {
  const tree = mkdtempSync(path.join(tmpdir(), `${taken.name}.`));

  for (const file of copied) {
    cpSync(path.join(root, file), path.join(tree, file));
  }

  symlinkSync(
    path.join(root, "apps/server/node_modules"),
    path.join(tree, "apps/server/node_modules")
  );

  writeFileSync(
    path.join(tree, taken.file),
    broken(readFileSync(path.join(root, taken.file), "utf8"), taken)
  );

  const model = path.join(tree, skill, "model");

  const exported = spawnSync(
    process.execPath,
    [
      path.join(tree, skill, "scripts/export-chart.ts"),
      path.join(model, "Chart.tla"),
    ],
    { encoding: "utf8" }
  );

  if (exported.status !== 0) {
    throw new Error(`${taken.name} doesn't export:\n${exported.stderr}`);
  }

  const checked = spawnSync(
    path.join(root, skill, "scripts/tlc.sh"),
    [model, taken.config],
    { stdio: ["ignore", "ignore", "inherit"] }
  );

  const output = readFileSync(path.join(model, "tlc.out"), "utf8");

  rmSync(tree, { recursive: true });

  return verdictOf(checked.status, output);
};

const asked = process.argv.slice(2);

const chosen = breaks.filter(
  ({ name }) => asked.length === 0 || asked.includes(name)
);

const missed = chosen.filter((taken) => {
  const verdict = run(taken);

  process.stdout.write(
    `${taken.name}: ${verdict}${verdict === taken.violated ? "" : `, not ${taken.violated}`}\n`
  );

  return verdict !== taken.violated;
});

process.exitCode = missed.length === 0 ? 0 : 1;

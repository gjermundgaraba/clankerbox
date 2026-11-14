import { Clock, Duration, Effect, Fiber, Logger, Schedule } from "effect";
import { Hex } from "effect/encoding";

import { endTimeout, markName, runCommand } from "../../src/guest.ts";
import type { Interface as Runtime, Target } from "../../src/runtime.ts";

const cutAfter = Duration.seconds(10);

const startSlack = Duration.seconds(1);

const settleFor = Duration.seconds(15);

interface Seen {
  readonly roles: ReadonlyMap<string, string>;
  readonly marks: ReadonlyMap<string, string>;
}

const rolesOf = (output: string, command: "cut" | "beside") =>
  new Map(
    output.split("\n").flatMap((line) => {
      const [of, role, pid] = line.split(" ");

      return of === command && role !== undefined && pid !== undefined
        ? [[role, pid] as const]
        : [];
    })
  );

const marksOf = (output: string) =>
  new Map(
    output.split("\n").flatMap((line) => {
      const [of, pid, mark] = line.split(" ");

      return of === "marked" && pid !== undefined && mark !== undefined
        ? [[pid, mark] as const]
        : [];
    })
  );

const holding = (seen: Seen, mark: string | undefined) =>
  [...seen.marks].flatMap(([pid, held]) => (held === mark ? [pid] : []));

const named = (seen: Seen, pids: readonly string[]) =>
  pids.map(
    (pid) =>
      [...seen.roles].find(([, rolePid]) => rolePid === pid)?.[0] ??
      `other ${pid}`
  );

/** What `endsACutCommand` answers when the end did its work. */
export const ended = {
  exitCode: 124,
  withinEndTimeout: true,
  warnings: [],
  survivors: [],
  besideRunsOn: true,
  besideEndsWithItsExec: true,
};

/**
 * Cuts, by its timeout, a guest command that starts a child and one that ignores TERM, and shows by
 * later execs that nothing carrying its exec's mark runs once it answers, while a command another
 * exec runs beside it still does until its own exec is cut. Each line it measures goes to `note`,
 * and it answers what `ended` holds when the end worked.
 */
export const endsACutCommand = (
  runtime: Runtime,
  machine: Target,
  note: (line: string) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const warned: string[] = [];
    const dir = `\${CLANKERBOX_ROOT-}/tmp/cbx-cut-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(4)))}`;

    const inGuest = (script: string) =>
      Effect.map(
        runCommand(runtime, { machine, argv: ["/bin/sh", "-c", script] }),
        ({ output }) => output
      );

    const facts = yield* inGuest(
      [
        `mkdir -p "${dir}"`,
        `echo "uid $(id -u) user $(id -un 2>/dev/null)"`,
        `echo "/bin/sh is $(readlink -f /bin/sh)"`,
        `if [ -r /proc/self/stat ]; then echo "/proc readable"; else echo "/proc unreadable"; fi`,
        `echo "ps $(command -v ps || echo none), grep $(command -v grep || echo none)"`,
      ].join("\n")
    );

    yield* note(`a default exec: ${facts.trim().split("\n").join("; ")}`);

    const seen = Effect.map(
      inGuest(
        [
          `for of in cut beside; do [ ! -e "${dir}/$of" ] || sed "s/^/$of /" "${dir}/$of"; done`,
          "for d in /proc/[0-9]*; do",
          `  state=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -c1)`,
          `  case $state in '' | Z | X) continue ;; esac`,
          `  mark=$(cat "$d/environ" "$d/cmdline" 2>/dev/null | tr '\\0' '\\n' | grep -x -m 1 '${markName}=[0-9a-f]*' | cut -d= -f2)`,
          `  [ -z "$mark" ] || [ "$mark" = "$${markName}" ] || echo "marked \${d#/proc/} $mark"`,
          "done",
        ].join("\n")
      ),
      (output): Seen => ({
        roles: new Map([
          ...rolesOf(output, "cut"),
          ...[...rolesOf(output, "beside")].map(
            ([role, pid]) => [`beside ${role}`, pid] as const
          ),
        ]),
        marks: marksOf(output),
      })
    );

    const command = (of: "cut" | "beside") =>
      [
        `echo "shell $$" >>"${dir}/${of}"`,
        `sleep 600 & echo "child $!" >>"${dir}/${of}"`,
        ...(of === "cut"
          ? [
              `sh -c 'trap "" TERM; echo "deaf $$" >>"$0"; exec sleep 600' "${dir}/${of}" &`,
            ]
          : []),
        "wait",
      ].join("\n");

    const warnings = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") {
          warned.push([message].flat().map(String).join(" "));
        }
      }),
    ]);

    const beside = yield* Effect.forkChild(
      runCommand(runtime, {
        machine,
        argv: ["/bin/sh", "-c", command("beside")],
      }).pipe(Effect.provide(warnings))
    );

    const began = yield* Clock.currentTimeMillis;

    const cut = yield* Effect.forkChild(
      runCommand(runtime, {
        machine,
        argv: ["/bin/sh", "-c", command("cut")],
        timeoutSeconds: Duration.toSeconds(cutAfter),
      }).pipe(Effect.provide(warnings))
    );

    const before = yield* Effect.timeoutOrElse(
      Effect.repeat(seen, {
        until: ({ roles, marks }) =>
          roles.size === 5 &&
          [...roles.values()].every((pid) => marks.has(pid)),
        schedule: Schedule.spaced("200 millis"),
      }),
      {
        duration: Duration.subtract(cutAfter, startSlack),
        orElse: () =>
          Effect.die(
            "the cut command's shell, child and TERM-ignoring child, and the beside command's shell and child, weren't all seen running and marked before the cut's timeout"
          ),
      }
    );

    const cutMark = before.marks.get(before.roles.get("shell") ?? "");
    const besideMark = before.marks.get(before.roles.get("beside shell") ?? "");

    yield* note(
      `before the timeout, the cut's mark is held by ${named(before, holding(before, cutMark)).join(", ")}, and the beside command's by ${named(before, holding(before, besideMark)).join(", ")}`
    );

    const answered = yield* Fiber.join(cut);

    const afterTimeout =
      (yield* Clock.currentTimeMillis) - began - Duration.toMillis(cutAfter);

    const after = yield* seen;
    const survivors = named(after, holding(after, cutMark));

    yield* note(
      `the timed-out exec answered ${answered.exitCode} ${afterTimeout} ms after its ${Duration.format(cutAfter)} timeout, of the ${Duration.format(endTimeout)} an end may take; at once after, the cut's mark is held by ${survivors.join(", ") || "nothing"}, and the beside command's by ${named(after, holding(after, besideMark)).join(", ")}; warnings: ${warned.join(" | ") || "none"}`
    );

    if (survivors.length > 0) {
      const settled = yield* Effect.timeoutOrElse(
        Effect.repeat(seen, {
          until: (now) => holding(now, cutMark).length === 0,
          schedule: Schedule.spaced("500 millis"),
        }),
        {
          duration: settleFor,
          orElse: () => seen,
        }
      );

      yield* note(
        `${Duration.format(settleFor)} on at most, the cut's mark is held by ${named(settled, holding(settled, cutMark)).join(", ") || "nothing"}, ${(yield* Clock.currentTimeMillis) - began - Duration.toMillis(cutAfter)} ms after the timeout`
      );
    }

    yield* Fiber.interrupt(beside);

    const besideCut = yield* seen;

    yield* note(
      `once the beside command's exec is cut too, its mark is held by ${named(besideCut, holding(besideCut, besideMark)).join(", ") || "nothing"}`
    );

    yield* inGuest(`rm -rf "${dir}"`);

    return {
      exitCode: answered.exitCode,
      withinEndTimeout:
        afterTimeout >= 0 &&
        afterTimeout <= Duration.toMillis(Duration.sum(endTimeout, startSlack)),
      warnings: warned,
      survivors,
      besideRunsOn:
        holding(after, besideMark).join(" ") ===
        holding(before, besideMark).join(" "),
      besideEndsWithItsExec: holding(besideCut, besideMark).length === 0,
    };
  });

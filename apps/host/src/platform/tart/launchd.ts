import { Result } from "effect";

/**
 * A launchd job as `launchctl print` shows it: `running` while launchd runs the job's program or
 * starts it, and `exited` once it ran no more, with the last exit code launchd recorded, if any.
 */
export type Job =
  | { readonly _tag: "running"; readonly program: readonly string[] }
  | {
      readonly _tag: "exited";
      readonly program: readonly string[];
      readonly lastExit: number | undefined;
    };

const states = new Map<string, Job["_tag"]>([
  ["not running", "exited"],
  ["spawn scheduled", "running"],
  ["xpcproxy", "running"],
  ["running", "running"],
]);

const line = (output: string, key: string): string | undefined =>
  new RegExp(`^\\t${key} = (.+)$`, "mu").exec(output)?.[1];

const programOf = (output: string): readonly string[] | undefined =>
  /^\targuments = \{\n(?<lines>(?:\t\t.*\n)*)\t\}$/mu
    .exec(output)
    ?.groups?.["lines"]?.split("\n")
    .filter((argument) => argument !== "")
    .map((argument) => argument.slice(2));

/**
 * The job `launchctl print gui/<uid>/<label>` printed, or what it printed that this host can't
 * read: no state or no arguments, or a state macOS didn't print when the `bump-tart` skill last
 * captured them, as a later macOS may.
 */
export const parse = (output: string): Result.Result<Job, string> => {
  const state = line(output, "state");
  const program = programOf(output);

  if (state === undefined || program === undefined) {
    return Result.fail("no state or arguments this host reads");
  }

  const read = states.get(state);

  if (read === undefined) {
    return Result.fail(`the state "${state}", which this host doesn't know`);
  }

  if (read === "running") {
    return Result.succeed({ _tag: "running", program });
  }

  const lastExit = line(output, "last exit code");

  return Result.succeed({
    _tag: "exited",
    program,
    lastExit:
      lastExit !== undefined && /^-?\d+$/u.test(lastExit)
        ? Number(lastExit)
        : undefined,
  });
};

/** A `tart run` process on the Mac: its pid, and the arguments after `run`, among them its VM. */
export interface TartRun {
  readonly pid: number;
  readonly arguments: readonly string[];
}

const processLine = /^\s*(?<pid>\d+) (?<name>.{16}) (?<args>.*)$/u;

const tartPath = /(?:^|\/)tart(?= )/u;

const afterRun = (args: string, name: string, binary: string) => {
  if (args.startsWith(`${binary} run `)) {
    return args.slice(`${binary} run `.length);
  }

  if (name !== "tart") {
    return "";
  }

  const executable = tartPath.exec(args);

  const rest = executable?.input.slice(
    executable.index + executable[0].length + " ".length
  );

  if (rest?.startsWith("run ") === true) {
    return rest.slice("run ".length);
  }

  const [first = "", second] = args.split(" ");

  return second === "run" ? args.slice(`${first} run `.length) : "";
};

/**
 * The `tart run` processes in `ps -axo pid=,ucomm=,args=`: those of `binary`, the host's own Tart,
 * whatever its file is named, and those of any executable named `tart`, which a link of another
 * name to it is too. `ps` pads a process's name, which may hold spaces, to the 16 characters macOS
 * keeps of it, and joins its arguments with spaces, so an executable's path ends at the first
 * `tart` that ends a segment, or, through a link, at the first space.
 */
export const tartRuns = (
  processes: string,
  binary: string
): readonly TartRun[] =>
  processes.split("\n").flatMap((text) => {
    const {
      pid = "",
      name = "",
      args = "",
    } = processLine.exec(text)?.groups ?? {};

    const rest = afterRun(args, name.trimEnd(), binary)
      .split(" ")
      .filter((argument) => argument !== "");

    return rest.length === 0 ? [] : [{ pid: Number(pid), arguments: rest }];
  });

/** Whether `run` runs `vm`, a handle: whether `vm` is among its arguments. */
export const names = (run: TartRun, vm: string): boolean =>
  run.arguments.includes(vm);

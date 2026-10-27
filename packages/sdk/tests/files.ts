import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const scratch = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "clankerbox-test-" })
);

export const read = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));

export const readBytes = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(path));

export const write = (path: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));

export const writeBytes = (path: string, bytes: Uint8Array) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFile(path, bytes));

export const mkdir = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeDirectory(path, { recursive: true })
  );

export const chmod = (path: string, mode: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(path, mode));

export const symlink = (target: string, path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, path));

export const utimes = (path: string, time: Date) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.utimes(path, time, time));

export const exists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path));

export const exitOf = (
  command: string,
  args: readonly string[],
  options?: ChildProcess.CommandOptions
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        stdout: "ignore",
        stderr: "ignore",
        ...options,
      })
    );

    return yield* handle.exitCode;
  });

export const outputOf = (
  command: string,
  args: readonly string[],
  options?: Omit<ChildProcess.CommandOptions, "stdin" | "stdout" | "stderr"> & {
    readonly input?: Uint8Array;
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { input, ...rest } = options ?? {};

      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          ...rest,
          stdin: input === undefined ? "ignore" : Stream.make(input),
        })
      );

      return yield* Effect.all(
        {
          code: handle.exitCode,
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
        },
        { concurrency: "unbounded" }
      );
    })
  );

export const stat = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path));

export const remove = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.remove(path, { recursive: true, force: true })
  );

export const readDirectory = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(path));

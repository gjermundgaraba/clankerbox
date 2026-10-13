/** Files for tests, through `FileSystem`, so a test needs only the platform's Layer. */
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A directory of the test's own, removed when the test's scope closes. */
export const scratch = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "clankerbox-test-" }),
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
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, { recursive: true }));

export const chmod = (path: string, mode: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(path, mode));

export const symlink = (target: string, path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, path));

export const utimes = (path: string, time: Date) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.utimes(path, time, time));

export const exists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path));

/** Runs `command` to its end, its output discarded, and returns its exit code. */
export const exitOf = (
  command: string,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdout: "ignore", stderr: "ignore", ...options }),
    );

    return yield* handle.exitCode;
  });

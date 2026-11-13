import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vite-plus/test";

/** How long a test program may run: well below `testLimit`, so the test reads how it ended. */
export const childLimit = 20_000;

/** The limit of a test that runs a test program. */
export const testLimit = childLimit + 10_000;

/**
 * Runs the test program `program`, beside this file, under Node, and ends it past `childLimit` and
 * when the test ends, whatever way it ends. Its stdin is this process's, so a program that calls
 * `endsWithParent` ends with this process too.
 */
export const run = async (program: string, args: readonly string[]) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(program, import.meta.url)), ...args],
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: childLimit,
      killSignal: "SIGKILL",
    }
  );

  onTestFinished(() => {
    child.kill("SIGKILL");
  });

  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "exit"),
  ]);

  return { code: child.exitCode, stdout, stderr };
};

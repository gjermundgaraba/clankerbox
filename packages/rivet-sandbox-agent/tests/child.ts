import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vite-plus/test";

export const childLimit = 20_000;

export const testLimit = childLimit + 10_000;

export const run = async (
  program: string,
  args: readonly string[],
  files?: number
) => {
  const node = [
    process.execPath,
    fileURLToPath(new URL(program, import.meta.url)),
    ...args,
  ];

  const child = spawn(
    files === undefined ? process.execPath : "/bin/sh",
    files === undefined
      ? node.slice(1)
      : ["-c", `ulimit -n ${files} && exec "$@"`, "sh", ...node],
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

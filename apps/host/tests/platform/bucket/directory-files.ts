import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import type { CheckpointFiles } from "../../../src/platform/bucket/builds.ts";
import { Handle } from "../../../src/runtime.ts";

const filesIn = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

const keyOf = (file: string) =>
  `fake/${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

export const directoryFiles = (
  dir: string,
  keyed: boolean
): CheckpointFiles => {
  const checkpoints = path.join(dir, "checkpoints");
  const root = (instance: string) => path.join(checkpoints, instance);

  return {
    checkpointFiles: (checkpoint) =>
      Effect.sync(() =>
        filesIn(root(checkpoint.instance)).map((file) => ({
          path: path.relative(root(checkpoint.instance), file),
          file,
          ...(keyed ? { key: keyOf(file) } : {}),
        }))
      ),
    held: (key) =>
      Effect.sync(() =>
        keyed && existsSync(checkpoints)
          ? filesIn(checkpoints).find(
              (file) => !file.includes(".fetching") && keyOf(file) === key
            )
          : undefined
      ),
    staging: (checkpoint) => `${root(checkpoint.instance)}.fetching`,
    install: (checkpoint, staged) =>
      Effect.sync(() => {
        renameSync(staged, root(checkpoint.instance));

        return Handle.make(checkpoint.instance);
      }),
  };
};

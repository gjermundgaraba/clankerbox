/** Scratch directories for tests, each removed when its test ends. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh scratch directory, recorded in `owned` for `removeScratch`. */
export const scratch = async (owned: Array<string>) => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-host-"));

  owned.push(dir);

  return dir;
};

export const removeScratch = async (owned: Array<string>) => {
  await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
};

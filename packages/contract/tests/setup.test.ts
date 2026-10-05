import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { packRecipe, readSetup } from "../src/index.ts";

const run = promisify(execFile);

const temporary: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-setup-"));

  temporary.push(dir);

  return dir;
};

const pack = (directory: string) =>
  packRecipe(directory).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

/**
 * A recipe whose setup.sh records where it ran and copies its files into $OUT. It holds an
 * executable helper whose name has a space.
 */
const recipe = async (setup: string) => {
  const dir = await scratch();

  await mkdir(join(dir, "files", "nested"), { recursive: true });
  await writeFile(join(dir, "setup.sh"), setup);
  await writeFile(join(dir, "files", "greeting"), "hello from files/\n");
  await writeFile(join(dir, "files", "nested", "data.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(dir, "files", "run me.sh"), '#!/bin/sh\necho helper ran >"$OUT/helper"\n');
  await chmod(join(dir, "files", "run me.sh"), 0o755);

  // An extended attribute is what makes macOS tar add a `._greeting` file unless told not to.
  if (process.platform === "darwin") {
    await run("xattr", ["-w", "com.example.clankerbox", "1", join(dir, "files", "greeting")]);
  }

  return dir;
};

const copyingSetup = [
  "#!/bin/sh",
  "set -eu",
  'pwd >"$OUT/ran-in"',
  'cp files/greeting "$OUT/greeting"',
  'cp files/nested/data.bin "$OUT/data.bin"',
  '"./files/run me.sh"',
  "",
].join("\n");

/** Runs a packed script with sh in a fresh directory, as a host would, and returns $OUT. */
const runPacked = async (script: string) => {
  const work = await scratch();
  const out = join(work, "out");

  await mkdir(out);
  await writeFile(join(work, "setup"), script);

  const result = await run("sh", [join(work, "setup")], {
    cwd: work,
    env: { ...process.env, OUT: out },
  }).then(
    () => 0,
    (error: { readonly code?: number }) => error.code ?? -1,
  );

  return { out, exitCode: result };
};

test("a recipe directory packs into one script that recreates its files and runs setup.sh", async () => {
  const script = await pack(await recipe(copyingSetup));
  const { out, exitCode } = await runPacked(script);

  expect(exitCode).toBe(0);
  expect(await readFile(join(out, "greeting"), "utf8")).toBe("hello from files/\n");
  expect([...(await readFile(join(out, "data.bin")))]).toEqual([0, 1, 2, 255]);
  expect(await readFile(join(out, "helper"), "utf8")).toBe("helper ran\n");

  const ranIn = (await readFile(join(out, "ran-in"), "utf8")).trim();

  expect(existsSync(ranIn)).toBe(false);
});

/** The tar archive inside a packed script, decoded from its here-document. */
const archiveOf = (script: string): Buffer => {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.includes("<<'CLANKERBOX_RECIPE'"));
  const end = lines.indexOf("CLANKERBOX_RECIPE", start + 1);

  return Buffer.from(lines.slice(start + 1, end).join(""), "base64");
};

test("the packed archive carries no AppleDouble files and no extended attributes", async () => {
  const archive = archiveOf(await pack(await recipe(copyingSetup)));

  const listing = await new Promise<string>((resolve, reject) => {
    const tar = execFile("tar", ["-t", "-f", "-"], (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    );

    tar.stdin?.end(archive);
  });

  const entries = listing.split("\n").filter((entry) => entry !== "");

  expect(entries).toContain("./files/greeting");
  expect(entries.filter((entry) => entry.includes("._"))).toEqual([]);
  expect(archive.includes("xattr")).toBe(false);
});

test("a failing setup.sh fails the script with its exit code, and the unpacked files are removed", async () => {
  const script = await pack(await recipe('#!/bin/sh\npwd >"$OUT/ran-in"\nexit 3\n'));
  const { out, exitCode } = await runPacked(script);

  expect(exitCode).toBe(3);

  const ranIn = (await readFile(join(out, "ran-in"), "utf8")).trim();

  expect(existsSync(ranIn)).toBe(false);
});

test("a recipe may hold its own top-level recipe.tar", async () => {
  const dir = await recipe('#!/bin/sh\ncp recipe.tar "$OUT/recipe.tar"\n');

  await writeFile(join(dir, "recipe.tar"), "the recipe's own\n");

  const { out, exitCode } = await runPacked(await pack(dir));

  expect(exitCode).toBe(0);
  expect(await readFile(join(out, "recipe.tar"), "utf8")).toBe("the recipe's own\n");
});

test("setup.sh runs through its #! line, with or without its execute bit", async () => {
  const dir = await recipe(
    '#!/usr/bin/awk -f\nBEGIN { print "awk ran" > (ENVIRON["OUT"] "/interpreter") }\n',
  );

  await chmod(join(dir, "setup.sh"), 0o644);

  const { out, exitCode } = await runPacked(await pack(dir));

  expect(exitCode).toBe(0);
  expect(await readFile(join(out, "interpreter"), "utf8")).toBe("awk ran\n");
});

test("a directory without setup.sh is refused with Invalid", async () => {
  const dir = await scratch();

  const error = await packRecipe(dir).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("setup.sh");
});

test("a setup.sh that isn't a file is refused, and an empty one packs like a file", async () => {
  const directory = await scratch();
  const empty = await scratch();

  await mkdir(join(directory, "setup.sh"));
  await writeFile(join(empty, "setup.sh"), "");

  const error = await packRecipe(directory).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  const { exitCode } = await runPacked(await pack(empty));

  expect(error.message).toContain("has no setup.sh");
  expect(exitCode).toBe(0);
});

test("a single file is sent as its text", async () => {
  const dir = await scratch();
  const file = join(dir, "setup.sh");

  await writeFile(file, "#!/bin/sh\ntrue\n");

  const text = await readSetup(file).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

  expect(text === "#!/bin/sh\ntrue\n").toBe(true);
});

test("a missing setup path is Invalid", async () => {
  const dir = await scratch();

  const error = await readSetup(join(dir, "missing")).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("Invalid");
});

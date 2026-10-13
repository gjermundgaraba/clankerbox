import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

test("the packed script carries no AppleDouble files and no extended attributes", async () => {
  const script = await pack(await recipe(copyingSetup));

  expect(script).toContain("'./files/greeting'");
  expect(script).not.toContain("._");
  expect(script).not.toContain("xattr");
});

test("the same files pack into the same script, whatever their times and modes but the execute bit", async () => {
  const dir = await recipe(copyingSetup);
  const first = await pack(dir);

  await utimes(join(dir, "files", "greeting"), new Date(0), new Date(0));
  await utimes(join(dir, "files"), new Date(0), new Date(0));
  await chmod(join(dir, "files", "greeting"), 0o600);
  await chmod(join(dir, "files", "nested"), 0o700);

  expect((await pack(dir)) === first).toBe(true);

  await chmod(join(dir, "files", "greeting"), 0o700);

  expect((await pack(dir)) === first).toBe(false);
});

test("a file keeps its execute bit, and no other mode", async () => {
  const dir = await recipe(
    [
      "#!/bin/sh",
      "set -eu",
      'test -x "files/run me.sh" && echo run >>"$OUT/executable"',
      'test -x files/secret && echo secret >>"$OUT/executable"',
      'test -w files/closed && echo closed >>"$OUT/writable"',
      "",
    ].join("\n"),
  );

  await writeFile(join(dir, "files", "secret"), "s\n");
  await chmod(join(dir, "files", "secret"), 0o600);
  await mkdir(join(dir, "files", "closed"));
  await chmod(join(dir, "files", "closed"), 0o500);

  try {
    const { out, exitCode } = await runPacked(await pack(dir));

    expect(exitCode).toBe(0);
    expect(await readFile(join(out, "executable"), "utf8")).toBe("run\n");
    expect(await readFile(join(out, "writable"), "utf8")).toBe("closed\n");
  } finally {
    await chmod(join(dir, "files", "closed"), 0o700);
  }
});

test("symlinks are recreated as they are and never walked into, wherever they point", async () => {
  const outside = await scratch();

  await writeFile(join(outside, "secret"), "outside the recipe\n");

  const dir = await recipe(
    [
      "#!/bin/sh",
      "set -eu",
      'cat alias/inside >"$OUT/alias"',
      'cat files/link >"$OUT/link"',
      'readlink out >"$OUT/out"',
      'readlink loop >"$OUT/loop"',
      "",
    ].join("\n"),
  );

  // `alias` sorts before the directory it points at, and `loop` at the recipe itself.
  await mkdir(join(dir, "real"));
  await writeFile(join(dir, "real", "inside"), "inside\n");
  await symlink("real", join(dir, "alias"));
  await symlink("greeting", join(dir, "files", "link"));
  await symlink(outside, join(dir, "out"));
  await symlink(".", join(dir, "loop"));

  const script = await pack(dir);

  expect(script).not.toContain(Buffer.from("outside the recipe\n").toString("base64"));
  expect(script).not.toContain("./out/");
  expect(script).not.toContain("./loop/");
  expect(script).not.toContain("./alias/");

  const { out, exitCode } = await runPacked(script);

  expect(exitCode).toBe(0);
  expect(await readFile(join(out, "alias"), "utf8")).toBe("inside\n");
  expect(await readFile(join(out, "link"), "utf8")).toBe("hello from files/\n");
  expect(await readFile(join(out, "out"), "utf8")).toBe(`${outside}\n`);
  expect(await readFile(join(out, "loop"), "utf8")).toBe(".\n");
});

test("names and link targets that start with - are no options", async () => {
  const dir = await recipe(
    [
      "#!/bin/sh",
      "set -eu",
      'cat ./-p/-f >"$OUT/file"',
      'test -x ./-p/-f && echo yes >"$OUT/executable"',
      'readlink ./-link >"$OUT/link"',
      "",
    ].join("\n"),
  );

  await mkdir(join(dir, "-p"));
  await writeFile(join(dir, "-p", "-f"), "dash\n");
  await chmod(join(dir, "-p", "-f"), 0o755);
  await symlink("-target", join(dir, "-link"));

  const { out, exitCode } = await runPacked(await pack(dir));

  expect(exitCode).toBe(0);
  expect(await readFile(join(out, "file"), "utf8")).toBe("dash\n");
  expect(await readFile(join(out, "executable"), "utf8")).toBe("yes\n");
  expect(await readFile(join(out, "link"), "utf8")).toBe("-target\n");
});

test("paths with quotes, spaces and newlines are recreated as they are", async () => {
  const dir = await recipe('#!/bin/sh\ncat odd/* >"$OUT/all"\n');
  const awkward = ["it's", 'a "quoted" name', "two\nlines", "$(touch pwned)"];

  await mkdir(join(dir, "odd"));

  for (const [index, name] of awkward.entries()) {
    await writeFile(join(dir, "odd", name), `${index}\n`);
  }

  const { out, exitCode } = await runPacked(await pack(dir));

  expect(exitCode).toBe(0);
  expect(existsSync(join(out, "..", "pwned"))).toBe(false);
  expect((await readFile(join(out, "all"), "utf8")).split("\n").toSorted()).toEqual(
    expect.arrayContaining(["0", "1", "2", "3"]),
  );
});

test("a recipe that holds anything but files, directories and symlinks is refused", async () => {
  const dir = await recipe("#!/bin/sh\ntrue\n");

  await run("mkfifo", [join(dir, "files", "pipe")]);

  const error = await packRecipe(dir).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("InvalidFile");
  expect(error.message).toContain("files/pipe");
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

test("a setup.sh without a #! line runs under /bin/sh", async () => {
  const dir = await recipe('echo sh ran >"$OUT/interpreter"\n');

  const { out, exitCode } = await runPacked(await pack(dir));

  expect(exitCode).toBe(0);
  expect(await readFile(join(out, "interpreter"), "utf8")).toBe("sh ran\n");
});

test("a directory without setup.sh is refused with InvalidFile", async () => {
  const dir = await scratch();

  const error = await packRecipe(dir).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("InvalidFile");
  expect(error.file).toBe(dir);
  expect(error.message).toContain("setup.sh");
});

test("a recipe path that can't be read for another reason says why, not that setup.sh is missing", async () => {
  const dir = await scratch();
  const file = join(dir, "not-a-directory");

  await writeFile(file, "");

  const error = await packRecipe(file).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("InvalidFile");
  expect(error.message).toContain(`couldn't pack recipe ${file}`);
  expect(error.message).not.toContain("has no setup.sh");
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

test("a missing setup path is InvalidFile", async () => {
  const dir = await scratch();

  const missing = join(dir, "missing");

  const error = await readSetup(missing).pipe(
    Effect.flip,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("InvalidFile");
  expect(error.file).toBe(missing);
});

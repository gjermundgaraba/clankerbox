import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { join } from "node:path";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { packRecipe, readSetup } from "../src/index.ts";
import {
  chmod,
  exists,
  exitOf,
  mkdir,
  read,
  readBytes,
  scratch,
  symlink,
  utimes,
  write,
  writeBytes,
} from "./files.ts";

/**
 * A recipe whose setup.sh records where it ran and copies its files into $OUT. It holds an
 * executable helper whose name has a space.
 */
const recipe = (setup: string) =>
  Effect.gen(function* () {
    const dir = yield* scratch;

    yield* mkdir(join(dir, "files", "nested"));
    yield* write(join(dir, "setup.sh"), setup);
    yield* write(join(dir, "files", "greeting"), "hello from files/\n");
    yield* writeBytes(join(dir, "files", "nested", "data.bin"), new Uint8Array([0, 1, 2, 255]));
    yield* write(join(dir, "files", "run me.sh"), '#!/bin/sh\necho helper ran >"$OUT/helper"\n');
    yield* chmod(join(dir, "files", "run me.sh"), 0o755);

    // An extended attribute is what makes macOS tar add a `._greeting` file unless told not to.
    if (process.platform === "darwin") {
      yield* exitOf("xattr", ["-w", "com.example.clankerbox", "1", join(dir, "files", "greeting")]);
    }

    return dir;
  });

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
const runPacked = (script: string) =>
  Effect.gen(function* () {
    const work = yield* scratch;
    const out = join(work, "out");

    yield* mkdir(out);
    yield* write(join(work, "setup"), script);

    const exitCode = yield* exitOf("sh", [join(work, "setup")], {
      cwd: work,
      env: { OUT: out },
      extendEnv: true,
    });

    return { out, exitCode };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a recipe directory packs into one script that recreates its files and runs setup.sh",
    () =>
      Effect.gen(function* () {
        const script = yield* packRecipe(yield* recipe(copyingSetup));
        const { out, exitCode } = yield* runPacked(script);

        expect(exitCode).toBe(0);
        expect(yield* read(join(out, "greeting"))).toBe("hello from files/\n");
        expect([...(yield* readBytes(join(out, "data.bin")))]).toEqual([0, 1, 2, 255]);
        expect(yield* read(join(out, "helper"))).toBe("helper ran\n");

        const ranIn = (yield* read(join(out, "ran-in"))).trim();

        expect(yield* exists(ranIn)).toBe(false);
      }),
  );

  it.effect("the packed script carries no AppleDouble files and no extended attributes", () =>
    Effect.gen(function* () {
      const script = yield* packRecipe(yield* recipe(copyingSetup));

      expect(script).toContain("'./files/greeting'");
      expect(script).not.toContain("._");
      expect(script).not.toContain("xattr");
    }),
  );

  it.effect(
    "the same files pack into the same script, whatever their times and modes but the execute bit",
    () =>
      Effect.gen(function* () {
        const dir = yield* recipe(copyingSetup);
        const first = yield* packRecipe(dir);

        yield* utimes(join(dir, "files", "greeting"), new Date(0));
        yield* utimes(join(dir, "files"), new Date(0));
        yield* chmod(join(dir, "files", "greeting"), 0o600);
        yield* chmod(join(dir, "files", "nested"), 0o700);

        expect((yield* packRecipe(dir)) === first).toBe(true);

        yield* chmod(join(dir, "files", "greeting"), 0o700);

        expect((yield* packRecipe(dir)) === first).toBe(false);
      }),
  );

  it.effect("a file keeps its execute bit, and no other mode", () =>
    Effect.gen(function* () {
      const dir = yield* recipe(
        [
          "#!/bin/sh",
          "set -eu",
          'test -x "files/run me.sh" && echo run >>"$OUT/executable"',
          'test -x files/secret && echo secret >>"$OUT/executable"',
          'test -w files/closed && echo closed >>"$OUT/writable"',
          "",
        ].join("\n"),
      );

      yield* write(join(dir, "files", "secret"), "s\n");
      yield* chmod(join(dir, "files", "secret"), 0o600);
      yield* mkdir(join(dir, "files", "closed"));
      yield* chmod(join(dir, "files", "closed"), 0o500);
      // The scratch directory's removal needs to write in it.
      yield* Effect.addFinalizer(() => Effect.orDie(chmod(join(dir, "files", "closed"), 0o700)));

      const { out, exitCode } = yield* runPacked(yield* packRecipe(dir));

      expect(exitCode).toBe(0);
      expect(yield* read(join(out, "executable"))).toBe("run\n");
      expect(yield* read(join(out, "writable"))).toBe("closed\n");
    }),
  );

  it.effect("symlinks are recreated as they are and never walked into, wherever they point", () =>
    Effect.gen(function* () {
      const outside = yield* scratch;

      yield* write(join(outside, "secret"), "outside the recipe\n");

      const dir = yield* recipe(
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
      yield* mkdir(join(dir, "real"));
      yield* write(join(dir, "real", "inside"), "inside\n");
      yield* symlink("real", join(dir, "alias"));
      yield* symlink("greeting", join(dir, "files", "link"));
      yield* symlink(outside, join(dir, "out"));
      yield* symlink(".", join(dir, "loop"));

      const script = yield* packRecipe(dir);

      expect(script).not.toContain(Buffer.from("outside the recipe\n").toString("base64"));
      expect(script).not.toContain("./out/");
      expect(script).not.toContain("./loop/");
      expect(script).not.toContain("./alias/");

      const { out, exitCode } = yield* runPacked(script);

      expect(exitCode).toBe(0);
      expect(yield* read(join(out, "alias"))).toBe("inside\n");
      expect(yield* read(join(out, "link"))).toBe("hello from files/\n");
      expect(yield* read(join(out, "out"))).toBe(`${outside}\n`);
      expect(yield* read(join(out, "loop"))).toBe(".\n");
    }),
  );

  it.effect("names and link targets that start with - are no options", () =>
    Effect.gen(function* () {
      const dir = yield* recipe(
        [
          "#!/bin/sh",
          "set -eu",
          'cat ./-p/-f >"$OUT/file"',
          'test -x ./-p/-f && echo yes >"$OUT/executable"',
          'readlink ./-link >"$OUT/link"',
          "",
        ].join("\n"),
      );

      yield* mkdir(join(dir, "-p"));
      yield* write(join(dir, "-p", "-f"), "dash\n");
      yield* chmod(join(dir, "-p", "-f"), 0o755);
      yield* symlink("-target", join(dir, "-link"));

      const { out, exitCode } = yield* runPacked(yield* packRecipe(dir));

      expect(exitCode).toBe(0);
      expect(yield* read(join(out, "file"))).toBe("dash\n");
      expect(yield* read(join(out, "executable"))).toBe("yes\n");
      expect(yield* read(join(out, "link"))).toBe("-target\n");
    }),
  );

  it.effect("paths with quotes, spaces and newlines are recreated as they are", () =>
    Effect.gen(function* () {
      const dir = yield* recipe('#!/bin/sh\ncat odd/* >"$OUT/all"\n');
      const awkward = ["it's", 'a "quoted" name', "two\nlines", "$(touch pwned)"];

      yield* mkdir(join(dir, "odd"));

      for (const [index, name] of awkward.entries()) {
        yield* write(join(dir, "odd", name), `${index}\n`);
      }

      const { out, exitCode } = yield* runPacked(yield* packRecipe(dir));

      expect(exitCode).toBe(0);
      expect(yield* exists(join(out, "..", "pwned"))).toBe(false);
      expect((yield* read(join(out, "all"))).split("\n").toSorted()).toEqual(
        expect.arrayContaining(["0", "1", "2", "3"]),
      );
    }),
  );

  it.effect("a recipe that holds anything but files, directories and symlinks is refused", () =>
    Effect.gen(function* () {
      const dir = yield* recipe("#!/bin/sh\ntrue\n");

      yield* exitOf("mkfifo", [join(dir, "files", "pipe")]);

      const error = yield* packRecipe(dir).pipe(Effect.flip);

      expect(error._tag).toBe("InvalidFile");
      expect(error.message).toContain("files/pipe");
    }),
  );

  it.effect(
    "a failing setup.sh fails the script with its exit code, and the unpacked files are removed",
    () =>
      Effect.gen(function* () {
        const script = yield* packRecipe(yield* recipe('#!/bin/sh\npwd >"$OUT/ran-in"\nexit 3\n'));
        const { out, exitCode } = yield* runPacked(script);

        expect(exitCode).toBe(3);

        const ranIn = (yield* read(join(out, "ran-in"))).trim();

        expect(yield* exists(ranIn)).toBe(false);
      }),
  );

  it.effect("a recipe may hold its own top-level recipe.tar", () =>
    Effect.gen(function* () {
      const dir = yield* recipe('#!/bin/sh\ncp recipe.tar "$OUT/recipe.tar"\n');

      yield* write(join(dir, "recipe.tar"), "the recipe's own\n");

      const { out, exitCode } = yield* runPacked(yield* packRecipe(dir));

      expect(exitCode).toBe(0);
      expect(yield* read(join(out, "recipe.tar"))).toBe("the recipe's own\n");
    }),
  );

  it.effect("setup.sh runs through its #! line, with or without its execute bit", () =>
    Effect.gen(function* () {
      const dir = yield* recipe(
        '#!/usr/bin/awk -f\nBEGIN { print "awk ran" > (ENVIRON["OUT"] "/interpreter") }\n',
      );

      yield* chmod(join(dir, "setup.sh"), 0o644);

      const { out, exitCode } = yield* runPacked(yield* packRecipe(dir));

      expect(exitCode).toBe(0);
      expect(yield* read(join(out, "interpreter"))).toBe("awk ran\n");
    }),
  );

  it.effect("a setup.sh without a #! line runs under /bin/sh", () =>
    Effect.gen(function* () {
      const dir = yield* recipe('echo sh ran >"$OUT/interpreter"\n');

      const { out, exitCode } = yield* runPacked(yield* packRecipe(dir));

      expect(exitCode).toBe(0);
      expect(yield* read(join(out, "interpreter"))).toBe("sh ran\n");
    }),
  );

  it.effect("a directory without setup.sh is refused with InvalidFile", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      const error = yield* packRecipe(dir).pipe(Effect.flip);

      expect(error._tag).toBe("InvalidFile");
      expect(error.file).toBe(dir);
      expect(error.message).toContain("setup.sh");
    }),
  );

  it.effect(
    "a recipe path that can't be read for another reason says why, not that setup.sh is missing",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const file = join(dir, "not-a-directory");

        yield* write(file, "");

        const error = yield* packRecipe(file).pipe(Effect.flip);

        expect(error._tag).toBe("InvalidFile");
        expect(error.message).toContain(`couldn't pack recipe ${file}`);
        expect(error.message).not.toContain("has no setup.sh");
      }),
  );

  it.effect("a setup.sh that isn't a file is refused, and an empty one packs like a file", () =>
    Effect.gen(function* () {
      const directory = yield* scratch;
      const empty = yield* scratch;

      yield* mkdir(join(directory, "setup.sh"));
      yield* write(join(empty, "setup.sh"), "");

      const error = yield* packRecipe(directory).pipe(Effect.flip);

      const { exitCode } = yield* runPacked(yield* packRecipe(empty));

      expect(error.message).toContain("has no setup.sh");
      expect(exitCode).toBe(0);
    }),
  );

  it.effect("a single file is sent as its text", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const file = join(dir, "setup.sh");

      yield* write(file, "#!/bin/sh\ntrue\n");

      const text = yield* readSetup(file);

      expect(text === "#!/bin/sh\ntrue\n").toBe(true);
    }),
  );

  it.effect("a missing setup path is InvalidFile", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      const missing = join(dir, "missing");

      const error = yield* readSetup(missing).pipe(Effect.flip);

      expect(error._tag).toBe("InvalidFile");
      expect(error.file).toBe(missing);
    }),
  );
});

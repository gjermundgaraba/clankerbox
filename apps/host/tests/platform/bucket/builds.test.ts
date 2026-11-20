import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";

import { PortProbe } from "../../../src/machine-ports.ts";
import {
  fetch,
  pieceBytes,
  publish,
} from "../../../src/platform/bucket/builds.ts";
import type {
  CheckpointFiles,
  Store,
} from "../../../src/platform/bucket/builds.ts";
import {
  make,
  minimumVersion,
  nativeName,
  templates,
} from "../../../src/platform/smolvm/smolvm.ts";
import type { Identity } from "../../../src/runtime.ts";
import { scripted } from "../../scripted.ts";
import { memoryBuildStore } from "../../support.ts";
import { directoryFiles } from "./directory-files.ts";

const Written = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        size: Schema.Finite,
        key: Schema.optionalKey(Schema.String),
        pieces: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
      })
    ),
  })
);

type ManifestFile = (typeof Written.Type)["files"][number];

const encoder = new TextEncoder();

const decoder = new TextDecoder();

type Copied = "keyed" | "pieced";

const smolvmIn = (stateDir: string, bucket: Store) => {
  const prefix = path.join(stateDir, "smolvm");

  mkdirSync(prefix, { recursive: true });

  for (const template of templates) {
    writeFileSync(path.join(prefix, template), "");
  }

  const spawner = scripted((call) =>
    call.args[0] === "--version"
      ? { stdout: `smolvm ${minimumVersion}\n` }
      : undefined
  );

  return make(
    {
      prefix,
      publishAddress: "127.0.0.1",
      ramBudgetMib: 4096,
      stateDir,
      arch: "x64",
      bucket,
    },
    { uid: 0, ended: () => Effect.succeed(true) }
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        spawner.layer,
        Layer.succeed(PortProbe, { free: () => Effect.succeed(true) })
      )
    )
  );
};

const checkpointRef = (instance: string) => ({
  name: instance,
  instance,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
});

const planted = (
  files: CheckpointFiles,
  checkpoint: Identity,
  contents: ReadonlyMap<string, string | Uint8Array>
) =>
  Effect.gen(function* () {
    const staged = files.staging(checkpoint);

    for (const [name, content] of contents) {
      mkdirSync(path.dirname(path.join(staged, name)), { recursive: true });
      writeFileSync(path.join(staged, name), content);
    }

    return { ...checkpoint, handle: yield* files.install(checkpoint, staged) };
  });

const tree = (root: string) =>
  readdirSync(root, { recursive: true, encoding: "utf8" }).toSorted();

const published = (
  copied: Copied,
  contents: ReadonlyMap<string, string | Uint8Array> = new Map<
    string,
    string | Uint8Array
  >([
    ["disk.raw", "the disk"],
    ["memory/one", "first memory"],
  ])
) =>
  Effect.gen(function* () {
    const root = yield* scratch;
    const from = directoryFiles(path.join(root, "from"), copied === "keyed");
    const memory = memoryBuildStore();

    yield* publish(
      memory.store,
      from,
      yield* planted(from, checkpointRef("built"), contents)
    );

    const to = path.join(root, "to");
    const local = directoryFiles(to, copied === "keyed");

    const manifest = () =>
      Schema.decodeSync(Written)(
        decoder.decode(memory.objects.get("builds/built.json"))
      );

    const rewrite = (change: (file: ManifestFile) => ManifestFile) => {
      memory.objects.set(
        "builds/built.json",
        encoder.encode(
          JSON.stringify({
            files: manifest().files.map((file, index) =>
              index === 0 ? change(file) : file
            ),
          })
        )
      );
    };

    const fetched = fetch(
      memory.store,
      local,
      checkpointRef("fetched"),
      "built",
      "web@1"
    );

    const disk = () => {
      const file = manifest().files.find((each) => each.path === "disk.raw");

      expect(file).toBeDefined();

      return file ?? { path: "disk.raw", size: 0 };
    };

    const leftBehind = () =>
      ["fetched", "fetched.fetching"].filter((name) =>
        existsSync(path.join(to, "checkpoints", name))
      );

    return { root, to, memory, disk, rewrite, fetched, leftBehind };
  });

const outside = "a relative path with no empty, . or .. part";

const overlap = "each path once, and none within another file";

const storeObject = `objects/${"0".repeat(64)}`;

const refusedManifests: ReadonlyArray<
  readonly [string, Copied, (file: ManifestFile) => ManifestFile, string]
> = [
  ["path is empty", "keyed", (file) => ({ ...file, path: "" }), outside],
  [
    "path is absolute",
    "keyed",
    (file) => ({ ...file, path: "/tmp/escaped" }),
    outside,
  ],
  [
    "path climbs out of staging",
    "keyed",
    (file) => ({ ...file, path: "../../../escaped" }),
    outside,
  ],
  [
    "path climbs out through a directory",
    "keyed",
    (file) => ({ ...file, path: "memory/../../../../escaped" }),
    outside,
  ],
  [
    "path is another file's too",
    "keyed",
    (file) => ({ ...file, path: "memory/one" }),
    overlap,
  ],
  [
    "file's path is the directory of a later file",
    "keyed",
    (file) => ({ ...file, path: "memory" }),
    overlap,
  ],
  [
    "file's path is within a later file",
    "keyed",
    (file) => ({ ...file, path: "memory/one/inner" }),
    overlap,
  ],
  [
    "key isn't a runtime's name and a SHA-256",
    "keyed",
    (file) => ({ ...file, key: "fake/../../escaped" }),
    "a runtime's name, / and a SHA-256 in hex",
  ],
  [
    "key isn't the object its objects/ path names",
    "keyed",
    (file) => ({ ...file, path: storeObject }),
    "a key of the SHA-256 its objects/ path names",
  ],
  [
    "file in pieces lies under objects/",
    "pieced",
    (file) => ({ ...file, path: storeObject }),
    "a path outside objects/, which holds keyed files",
  ],
  [
    "file has both a key and pieces",
    "keyed",
    (file) => ({ ...file, pieces: [null] }),
    "Expected no excess property",
  ],
  [
    "piece isn't a SHA-256",
    "pieced",
    (file) => ({ ...file, pieces: ["../escaped"] }),
    "a SHA-256 in hex",
  ],
  [
    "pieces don't cover its size",
    "pieced",
    (file) => ({ ...file, pieces: [null, null] }),
    "one piece for each 16777216 bytes of its size",
  ],
  [
    "size is negative",
    "pieced",
    (file) => ({ ...file, size: -1, pieces: [] }),
    "Expected a value greater than or equal to 0",
  ],
];

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  for (const [what, copied, change, reason] of refusedManifests) {
    it.effect(
      `a fetch refuses a manifest whose ${what}, and writes nothing`,
      () =>
        Effect.gen(function* () {
          const { root, rewrite, fetched } = yield* published(copied);
          const before = tree(root);

          rewrite(change);

          const error = yield* Effect.flip(fetched);

          expect(error._tag).toBe("Internal");
          expect(error.message).toContain(
            "build store object builds/built.json isn't a manifest"
          );
          expect(error.message).toContain(reason);
          expect(tree(root)).toStrictEqual(before);
        })
    );
  }

  it.effect(
    "a fetch refuses an object that isn't the size its manifest says, and installs nothing",
    () =>
      Effect.gen(function* () {
        const { memory, disk, fetched, leftBehind } = yield* published("keyed");

        memory.objects.set(`objects/${disk().key}`, encoder.encode("the dis"));

        const error = yield* Effect.flip(fetched);

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain(
          "of disk.raw holds 7 bytes, not the manifest's 8"
        );
        expect(leftBehind()).toStrictEqual([]);
      })
  );

  it.effect(
    "a fetch refuses a piece that doesn't hash to its name, and installs nothing",
    () =>
      Effect.gen(function* () {
        const { memory, disk, fetched, leftBehind } =
          yield* published("pieced");

        memory.objects.set(
          `objects/pieces/${disk().pieces?.[0]}`,
          gzipSync("the dusk")
        );

        const error = yield* Effect.flip(fetched);

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain(
          `build piece 0 of disk.raw doesn't hash to ${disk().pieces?.[0]}`
        );
        expect(leftBehind()).toStrictEqual([]);
      })
  );

  it.effect(
    "a fetch refuses a piece that isn't the length its place in the file says, and installs nothing",
    () =>
      Effect.gen(function* () {
        const { memory, disk, fetched, leftBehind } =
          yield* published("pieced");

        memory.objects.set(
          `objects/pieces/${disk().pieces?.[0]}`,
          gzipSync("the disk, and more")
        );

        const error = yield* Effect.flip(fetched);

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain(
          "build piece 0 of disk.raw holds 18 bytes, not 8"
        );
        expect(leftBehind()).toStrictEqual([]);
      })
  );

  it.effect(
    "a fetch puts a file in pieces back together, a piece of zeros and a short last piece included",
    () =>
      Effect.gen(function* () {
        const disk = new Uint8Array(pieceBytes + 4);

        disk.set(encoder.encode("tail"), pieceBytes);

        const { to, fetched } = yield* published(
          "pieced",
          new Map<string, string | Uint8Array>([
            ["disk.raw", disk],
            ["empty", ""],
          ])
        );

        yield* fetched;

        const installed = path.join(to, "checkpoints", "fetched");

        expect(
          readFileSync(path.join(installed, "disk.raw")).equals(disk)
        ).toBe(true);
        expect(readFileSync(path.join(installed, "empty"))).toHaveLength(0);
      })
  );

  it.effect(
    "a fetch on smolvm installs what a smolvm publish wrote, each object into the host's store",
    () =>
      Effect.gen(function* () {
        const root = yield* scratch;
        const hash = createHash("sha256").update("a chunk").digest("hex");
        const object = path.join("objects", hash);
        const built = checkpointRef("built");
        const fetchedRef = checkpointRef("fetched");
        const memory = memoryBuildStore();

        const checkpointIn = (dir: string, ref: typeof built) =>
          path.join(dir, "checkpoints", `${nativeName(ref)}.checkpoint`);

        const from = path.join(root, "from");

        for (const [file, content] of [
          [object, "a chunk"],
          ["checkpoint.json", "{}"],
        ] as const) {
          const target = path.join(checkpointIn(from, built), file);

          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, content);
        }

        yield* (yield* smolvmIn(from, memory.store)).builds.publish({
          ...built,
          handle: nativeName(built),
        });

        const to = path.join(root, "to");

        yield* (yield* smolvmIn(to, memory.store)).builds.fetch(
          fetchedRef,
          "built",
          "web@1"
        );

        const installed = checkpointIn(to, fetchedRef);

        expect(readFileSync(path.join(installed, object), "utf8")).toBe(
          "a chunk"
        );
        expect(
          readFileSync(path.join(installed, "checkpoint.json"), "utf8")
        ).toBe("{}");
        expect(statSync(path.join(to, "checkpoints", object)).ino).toBe(
          statSync(path.join(installed, object)).ino
        );
      })
  );
});

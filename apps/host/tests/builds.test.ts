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
import type { Kind } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";

import { fetch, pieceBytes, publish } from "../src/builds.ts";
import {
  make,
  minimumVersion,
  nativeName,
  templates,
} from "../src/platform/smolvm.ts";
import { Runtime } from "../src/runtime.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import { scripted } from "./scripted.ts";
import { memoryBuildStore } from "./support.ts";

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

const runtimeIn = (dir: string, kind: Kind) =>
  Effect.map(
    Layer.build(fakeRuntime({ dir, kind }).layer),
    Context.get(Runtime)
  );

const smolvmIn = (stateDir: string) => {
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
      bootId: "b00710ad",
    },
    0
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, spawner.layer)));
};

const checkpointRef = (instance: string) => ({
  name: instance,
  instance,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: 2222,
});

const tree = (root: string) =>
  readdirSync(root, { recursive: true, encoding: "utf8" }).toSorted();

const published = (
  kind: Kind,
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
    const from = path.join(root, "from");
    const built = path.join(from, "checkpoints", "built");
    const memory = memoryBuildStore();

    for (const [name, content] of contents) {
      mkdirSync(path.dirname(path.join(built, name)), { recursive: true });
      writeFileSync(path.join(built, name), content);
    }

    yield* publish(
      memory.store,
      yield* runtimeIn(from, kind),
      checkpointRef("built")
    );

    const to = path.join(root, "to");
    const runtime = yield* runtimeIn(to, kind);

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
      runtime,
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
  readonly [string, Kind, (file: ManifestFile) => ManifestFile, string]
> = [
  ["path is empty", "linux", (file) => ({ ...file, path: "" }), outside],
  [
    "path is absolute",
    "linux",
    (file) => ({ ...file, path: "/tmp/escaped" }),
    outside,
  ],
  [
    "path climbs out of staging",
    "linux",
    (file) => ({ ...file, path: "../../../escaped" }),
    outside,
  ],
  [
    "path climbs out through a directory",
    "linux",
    (file) => ({ ...file, path: "memory/../../../../escaped" }),
    outside,
  ],
  [
    "path is another file's too",
    "linux",
    (file) => ({ ...file, path: "memory/one" }),
    overlap,
  ],
  [
    "file's path is the directory of a later file",
    "linux",
    (file) => ({ ...file, path: "memory" }),
    overlap,
  ],
  [
    "file's path is within a later file",
    "linux",
    (file) => ({ ...file, path: "memory/one/inner" }),
    overlap,
  ],
  [
    "key isn't a runtime's name and a SHA-256",
    "linux",
    (file) => ({ ...file, key: "fake/../../escaped" }),
    "a runtime's name, / and a SHA-256 in hex",
  ],
  [
    "key isn't the object its objects/ path names",
    "linux",
    (file) => ({ ...file, path: storeObject }),
    "a key of the SHA-256 its objects/ path names",
  ],
  [
    "file in pieces lies under objects/",
    "mac",
    (file) => ({ ...file, path: storeObject }),
    "a path outside objects/, which holds keyed files",
  ],
  [
    "file has both a key and pieces",
    "linux",
    (file) => ({ ...file, pieces: [null] }),
    "Expected no excess property",
  ],
  [
    "piece isn't a SHA-256",
    "mac",
    (file) => ({ ...file, pieces: ["../escaped"] }),
    "a SHA-256 in hex",
  ],
  [
    "pieces don't cover its size",
    "mac",
    (file) => ({ ...file, pieces: [null, null] }),
    "one piece for each 16777216 bytes of its size",
  ],
  [
    "size is negative",
    "mac",
    (file) => ({ ...file, size: -1, pieces: [] }),
    "Expected a value greater than or equal to 0",
  ],
];

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  for (const [what, kind, change, reason] of refusedManifests) {
    it.effect(
      `a fetch refuses a manifest whose ${what}, and writes nothing`,
      () =>
        Effect.gen(function* () {
          const { root, rewrite, fetched } = yield* published(kind);
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
        const { memory, disk, fetched, leftBehind } = yield* published("linux");

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
        const { memory, disk, fetched, leftBehind } = yield* published("mac");

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
        const { memory, disk, fetched, leftBehind } = yield* published("mac");

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
          "mac",
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

        yield* publish(memory.store, yield* smolvmIn(from), built);

        const to = path.join(root, "to");

        yield* fetch(
          memory.store,
          yield* smolvmIn(to),
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

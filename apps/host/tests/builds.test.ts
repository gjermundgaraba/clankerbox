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
import { Context, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";

import { fetch, pieceBytes, publish } from "../src/builds.ts";
import {
  make,
  minimumVersion,
  nativeName,
  templates,
} from "../src/platform/smolvm/smolvm.ts";
import { Runtime } from "../src/runtime.ts";
import type { Identity } from "../src/runtime.ts";
import type { FakeRuntimeName } from "./fake-runtime.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import { scripted } from "./scripted.ts";
import { filesOf, memoryBuildStore } from "./support.ts";

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

const runtimeIn = (dir: string, faked: FakeRuntimeName) =>
  Effect.map(
    Layer.build(fakeRuntime({ dir, as: faked }).layer),
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
    { uid: 0, ended: () => Effect.succeed(true) }
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, spawner.layer)));
};

const checkpointRef = (instance: string) => ({
  name: instance,
  instance,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
});

const planted = (
  runtime: Runtime["Service"],
  checkpoint: Identity,
  contents: ReadonlyMap<string, string | Uint8Array>
) =>
  Effect.gen(function* () {
    const files = yield* Effect.fromNullishOr(runtime.files);
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
  faked: FakeRuntimeName,
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
    const from = yield* runtimeIn(path.join(root, "from"), faked);
    const memory = memoryBuildStore();

    yield* publish(
      memory.store,
      yield* filesOf(from),
      yield* planted(from, checkpointRef("built"), contents)
    );

    const to = path.join(root, "to");
    const runtime = yield* runtimeIn(to, faked);

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
      yield* filesOf(runtime),
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
  readonly [
    string,
    FakeRuntimeName,
    (file: ManifestFile) => ManifestFile,
    string,
  ]
> = [
  ["path is empty", "smolvm", (file) => ({ ...file, path: "" }), outside],
  [
    "path is absolute",
    "smolvm",
    (file) => ({ ...file, path: "/tmp/escaped" }),
    outside,
  ],
  [
    "path climbs out of staging",
    "smolvm",
    (file) => ({ ...file, path: "../../../escaped" }),
    outside,
  ],
  [
    "path climbs out through a directory",
    "smolvm",
    (file) => ({ ...file, path: "memory/../../../../escaped" }),
    outside,
  ],
  [
    "path is another file's too",
    "smolvm",
    (file) => ({ ...file, path: "memory/one" }),
    overlap,
  ],
  [
    "file's path is the directory of a later file",
    "smolvm",
    (file) => ({ ...file, path: "memory" }),
    overlap,
  ],
  [
    "file's path is within a later file",
    "smolvm",
    (file) => ({ ...file, path: "memory/one/inner" }),
    overlap,
  ],
  [
    "key isn't a runtime's name and a SHA-256",
    "smolvm",
    (file) => ({ ...file, key: "fake/../../escaped" }),
    "a runtime's name, / and a SHA-256 in hex",
  ],
  [
    "key isn't the object its objects/ path names",
    "smolvm",
    (file) => ({ ...file, path: storeObject }),
    "a key of the SHA-256 its objects/ path names",
  ],
  [
    "file in pieces lies under objects/",
    "tart",
    (file) => ({ ...file, path: storeObject }),
    "a path outside objects/, which holds keyed files",
  ],
  [
    "file has both a key and pieces",
    "smolvm",
    (file) => ({ ...file, pieces: [null] }),
    "Expected no excess property",
  ],
  [
    "piece isn't a SHA-256",
    "tart",
    (file) => ({ ...file, pieces: ["../escaped"] }),
    "a SHA-256 in hex",
  ],
  [
    "pieces don't cover its size",
    "tart",
    (file) => ({ ...file, pieces: [null, null] }),
    "one piece for each 16777216 bytes of its size",
  ],
  [
    "size is negative",
    "tart",
    (file) => ({ ...file, size: -1, pieces: [] }),
    "Expected a value greater than or equal to 0",
  ],
];

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  for (const [what, faked, change, reason] of refusedManifests) {
    it.effect(
      `a fetch refuses a manifest whose ${what}, and writes nothing`,
      () =>
        Effect.gen(function* () {
          const { root, rewrite, fetched } = yield* published(faked);
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
        const { memory, disk, fetched, leftBehind } =
          yield* published("smolvm");

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
        const { memory, disk, fetched, leftBehind } = yield* published("tart");

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
        const { memory, disk, fetched, leftBehind } = yield* published("tart");

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
          "tart",
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

        yield* publish(memory.store, yield* filesOf(yield* smolvmIn(from)), {
          ...built,
          handle: nativeName(built),
        });

        const to = path.join(root, "to");

        yield* fetch(
          memory.store,
          yield* filesOf(yield* smolvmIn(to)),
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

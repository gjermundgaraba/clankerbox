import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { Kind } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";

import { fetch, publish } from "../src/builds.ts";
import type { Interface } from "../src/builds.ts";
import { Runtime } from "../src/runtime.ts";
import { fakeRuntime } from "./fake-runtime.ts";

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

const memoryStore = () => {
  const objects = new Map<string, Uint8Array>();

  const store: Interface = {
    list: (prefix) =>
      Effect.sync(() =>
        [...objects.keys()].filter((key) => key.startsWith(prefix)).toSorted()
      ),
    get: (key) =>
      Effect.suspend(() => {
        const body = objects.get(key);

        return body === undefined
          ? Effect.fail(new Internal({ message: `no object ${key}` }))
          : Effect.succeed(body);
      }),
    put: (key, body) =>
      Effect.sync(() => {
        objects.set(key, body);
      }),
    remove: (keys) =>
      Effect.sync(() => {
        for (const key of keys) {
          objects.delete(key);
        }
      }),
  };

  return { objects, store };
};

const runtimeIn = (dir: string, kind: Kind) =>
  Effect.map(
    Layer.build(fakeRuntime({ dir, kind }).layer),
    Context.get(Runtime)
  );

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

const published = (kind: Kind) =>
  Effect.gen(function* () {
    const root = yield* scratch;
    const from = path.join(root, "from");
    const built = path.join(from, "checkpoints", "built");
    const memory = memoryStore();

    mkdirSync(path.join(built, "memory"), { recursive: true });
    writeFileSync(path.join(built, "disk.raw"), "the disk");
    writeFileSync(path.join(built, "memory", "one"), "first memory");

    yield* publish(
      memory.store,
      yield* runtimeIn(from, kind),
      checkpointRef("built"),
      "built"
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

    return { root, to, memory, manifest, rewrite, fetched };
  });

const outside = "a relative path with no empty, . or .. part";

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
    "key isn't a runtime's name and a SHA-256",
    "linux",
    (file) => ({ ...file, key: "fake/../../escaped" }),
    "a runtime's name, / and a SHA-256 in hex",
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
          const { root, to, rewrite, fetched } = yield* published(kind);
          const before = tree(root);

          rewrite(change);

          const error = yield* Effect.flip(fetched);

          expect(error._tag).toBe("Internal");
          expect(error.message).toContain(
            "build store object builds/built.json isn't a manifest"
          );
          expect(error.message).toContain(reason);
          expect(tree(root)).toStrictEqual(before);
          expect(existsSync(path.join(to, "checkpoints", "fetched"))).toBe(
            false
          );
        })
    );
  }
});

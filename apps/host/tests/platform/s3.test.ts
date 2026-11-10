import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect";

import { BuildStore, fetch, publish } from "../../src/builds.ts";
import { BuildsSettings, make } from "../../src/platform/s3.ts";
import { Runtime } from "../../src/runtime.ts";
import { fakeRuntime } from "../fake-runtime.ts";
import { dockerAnswers, seaweedfs } from "./seaweedfs.ts";

class Seaweed extends Context.Service<Seaweed, BuildsSettings>()(
  "tests/platform/Seaweed"
) {}

const stored = Layer.effect(
  BuildStore,
  Effect.gen(function* () {
    return yield* make(yield* Seaweed);
  })
).pipe(
  Layer.provideMerge(
    Layer.effect(
      Seaweed,
      Effect.flatMap(seaweedfs, Schema.decodeUnknownEffect(BuildsSettings))
    )
  ),
  Layer.provideMerge(NodeHttpClient.layerNodeHttp)
);

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const runtimeIn = (dir: string) =>
  Effect.map(Layer.build(fakeRuntime({ dir }).layer), Context.get(Runtime));

const checkpointRef = (instance: string) => ({
  name: instance,
  instance,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: 2222,
});

const files = (root: string, contents: Readonly<Record<string, string>>) => {
  for (const [name, content] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
};

describe.skipIf(!dockerAnswers && process.env["CI"] === undefined)(
  "the S3 build store, against SeaweedFS",
  () => {
    layer(stored, {
      excludeTestServices: true,
      timeout: Duration.minutes(2),
    })((it) => {
      it.effect("a put key reads back, and lists under its prefix", () =>
        Effect.gen(function* () {
          const store = yield* BuildStore;

          yield* store.put("builds/ubuntu.json", encoder.encode('{"a":1}'));
          yield* store.put("objects/one", encoder.encode("one"));

          expect(decoder.decode(yield* store.get("builds/ubuntu.json"))).toBe(
            '{"a":1}'
          );
          expect(yield* store.list("builds/")).toStrictEqual([
            "builds/ubuntu.json",
          ]);
        })
      );

      it.effect(
        "a list pages past a thousand keys",
        () =>
          Effect.gen(function* () {
            const store = yield* BuildStore;

            const keys = Array.from(
              { length: 1005 },
              (_, index) => `many/${String(index).padStart(4, "0")}`
            );

            yield* Effect.forEach(
              keys,
              (key) => store.put(key, encoder.encode(key)),
              { concurrency: 32, discard: true }
            );

            expect(yield* store.list("many/")).toStrictEqual(keys);
          }),
        60_000
      );

      it.effect("a remove of a key that isn't there succeeds", () =>
        Effect.gen(function* () {
          const store = yield* BuildStore;

          yield* store.put("gone/kept", encoder.encode("kept"));
          yield* store.remove(["gone/never-put", "gone/kept"]);

          expect(yield* store.list("gone/")).toStrictEqual([]);
        })
      );

      it.effect("a wrong secret fails Internal and never prints it", () =>
        Effect.gen(function* () {
          const settings = yield* Seaweed;
          const wrong = "wrong-secret-that-never-prints";

          const store = yield* make({
            ...settings,
            secretAccessKey: Redacted.make(wrong),
          });

          const error = yield* Effect.flip(
            store.put("objects/refused", encoder.encode("refused"))
          );

          const printed = `${error.message} ${String(error)} ${JSON.stringify(error)}`;

          expect(error._tag).toBe("Internal");
          expect(error.message).toContain("PutObject of objects/refused");
          expect(error.message).toContain("403 SignatureDoesNotMatch");
          expect(printed).not.toContain(wrong);
          expect(printed).not.toContain(
            Redacted.value(settings.secretAccessKey)
          );
        })
      );

      it.effect("a fetch downloads only the keys the host lacks", () =>
        Effect.gen(function* () {
          const store = yield* BuildStore;
          const from = yield* scratch;
          const to = yield* scratch;
          const gets: string[] = [];

          const counted = {
            ...store,
            get: (key: string) =>
              Effect.andThen(
                Effect.sync(() => gets.push(key)),
                store.get(key)
              ),
          };

          files(path.join(from, "checkpoints", "built"), {
            "disk.raw": "the disk",
            "memory/one": "first memory",
            "memory/two": "second memory",
          });
          files(path.join(to, "checkpoints", "earlier"), {
            "disk.raw": "the disk",
          });

          yield* publish(store, yield* runtimeIn(from), checkpointRef("built"));
          yield* fetch(
            counted,
            yield* runtimeIn(to),
            checkpointRef("fetched"),
            "built",
            "web@1"
          );

          const fetched = path.join(to, "checkpoints", "fetched");

          expect(gets.filter((key) => key.startsWith("objects/"))).toHaveLength(
            2
          );
          expect(readFileSync(path.join(fetched, "disk.raw"), "utf8")).toBe(
            "the disk"
          );
          expect(
            readFileSync(path.join(fetched, "memory", "two"), "utf8")
          ).toBe("second memory");
        }).pipe(Effect.provide(NodeServices.layer))
      );
    });
  }
);

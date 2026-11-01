import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect } from "effect";
import type { Schema } from "effect";
import { expect } from "vite-plus/test";

import { loadConfig } from "../../src/composition/config.ts";
import { defaultFailedRowsLast, defaultRecheck } from "../../src/settings.ts";

const config = {
  listen: { address: "100.95.240.37", port: 8585 },
  stateDir: "state",
  hosts: [
    { id: "linux", url: "http://100.95.240.37:8484" },
    { id: "mac", url: "http://100.122.69.11:8484", draining: true },
  ],
};

const load = (contents: Schema.Json) =>
  Effect.gen(function* () {
    const file = path.join(yield* scratch, "server.json");

    yield* write(file, JSON.stringify(contents));

    return { file, loaded: loadConfig(file) };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a server config resolves its state dir against its own directory, and a host drains only when it says so",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load(config);

        expect(yield* loaded).toStrictEqual({
          listen: { address: "100.95.240.37", port: 8585 },
          stateDir: path.join(file, "..", "state"),
          hosts: [
            {
              id: "linux",
              url: "http://100.95.240.37:8484",
              draining: false,
            },
            { id: "mac", url: "http://100.122.69.11:8484", draining: true },
          ],
          recheck: defaultRecheck,
          failedRowsLast: defaultFailedRowsLast,
        });
      })
  );

  it.effect("an absolute state dir stays as it is", () =>
    Effect.gen(function* () {
      const { loaded } = yield* load({
        ...config,
        stateDir: "/var/clankerbox",
      });

      expect((yield* loaded).stateDir).toBe("/var/clankerbox");
    })
  );

  it.effect("a host listed twice is Invalid, naming it", () =>
    Effect.gen(function* () {
      const { file, loaded } = yield* load({
        ...config,
        hosts: [
          { id: "linux", url: "http://a:8484" },
          { id: "linux", url: "http://b:8484" },
        ],
      });

      const error = yield* Effect.flip(loaded);

      expect([error._tag, error.file]).toStrictEqual(["Invalid", file]);
      expect(error.message).toContain("host linux is listed twice");
    })
  );

  it.effect(
    "a config that isn't one is Invalid and names its file: bad JSON, a wrong field, an unknown one",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const unparsed = path.join(dir, "broken.json");

        yield* write(unparsed, "{");

        const contents: readonly Schema.Json[] = [
          { ...config, listen: { ...config.listen, port: 0 } },
          { ...config, listen: { ...config.listen, address: "0.0.0.0" } },
          { ...config, listen: { ...config.listen, port: 65_536 } },
          { ...config, hosts: [{ id: "not a host id", url: "http://a:8484" }] },
          { ...config, hosts: [{ id: "linux" }] },
          { listen: config.listen, hosts: config.hosts },
          { ...config, recheck: 30 },
          { ...config, hosts: [{ ...config.hosts[0], kind: "linux" }] },
        ];

        const errors = [
          yield* Effect.flip(loadConfig(unparsed)),
          ...(yield* Effect.forEach(contents, (each) =>
            Effect.flatMap(load(each), ({ loaded }) => Effect.flip(loaded))
          )),
        ];

        expect(errors.map(({ _tag }) => _tag)).toStrictEqual(
          errors.map(() => "Invalid")
        );
        expect(errors.map(({ file }) => file === undefined)).not.toContain(
          true
        );
      })
  );

  it.effect("a config that can't be read is Invalid and names its file", () =>
    Effect.gen(function* () {
      const file = path.join(yield* scratch, "missing.json");
      const error = yield* Effect.flip(loadConfig(file));

      expect([error._tag, error.file]).toStrictEqual(["Invalid", file]);
      expect(error.message).toContain("couldn't read server config");
    })
  );
});

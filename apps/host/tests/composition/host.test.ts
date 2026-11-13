import path from "node:path";

import { Handle } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Schedule,
} from "effect";
import { expect } from "vite-plus/test";

import { hostLayer } from "../../src/composition/host.ts";
import type { HostLayerConfig } from "../../src/composition/host.ts";
import { fakeRuntime } from "../fake-runtime.ts";
import type { FakeRuntimeName } from "../fake-runtime.ts";
import { hostConfig, hostOn, loopbackServer, noHttp } from "../support.ts";

const started = hostOn({ first: 21_140, last: 21_149 });

const refused = (
  settings: HostLayerConfig,
  dir: string,
  as?: FakeRuntimeName,
  calls: string[] = []
) =>
  Effect.flip(
    Layer.build(
      hostLayer(
        settings,
        fakeRuntime({
          dir,
          as,
          onCall: (call) => {
            calls.push(call);
          },
        }).layer,
        loopbackServer(settings.listen.port)
      ).pipe(Layer.provide(noHttp))
    )
  ).pipe(Effect.scoped, Effect.provide(Logger.layer([])));

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a host clears what its runtime left before it serves", () =>
    Effect.gen(function* () {
      const { fake } = yield* started();

      expect(fake.calls).toStrictEqual(["startup"]);
    })
  );

  it.effect(
    "a host that restarts answers another boot, and holds no operation of the last",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const first = yield* started({ dir });

        yield* first.operations.run({
          id: "op-1",
          boot: first.operations.boot,
          scope: { resource: "machine", name: "dev" },
          sequence: 1,
          step: {
            _tag: "remove",
            keep: [],
            machine: { name: "dev", instance: "1".repeat(32) },
          },
        });
        yield* first.dispose;

        const second = yield* started({ dir });
        const report = yield* second.operations.wait("op-1");

        expect(report.status).toBe("absent");
        expect(report.boot).toBe(second.operations.boot);
        expect(report.boot).not.toBe(first.operations.boot);
      })
  );

  it.effect(
    "a host told to stop ends an exec still running at once, rather than wait for it, and logs no error for it",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const errors: unknown[] = [];

        const host = yield* started({
          dir,
          logger: Logger.make(({ message, logLevel }) => {
            if (logLevel === "Error" || logLevel === "Fatal") {
              errors.push(message);
            }
          }),
        });

        const handle = Handle.make("held-dev");

        const machine = {
          name: "dev",
          instance: "1".repeat(32),
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
          handle,
        };

        const began = path.join(dir, "began");

        host.fake.hold({
          state: "running",
          name: machine.name,
          root: "",
          instance: machine.instance,
          handle,
        });

        const exec = yield* Effect.forkChild(
          Effect.promise(
            async () =>
              await fetch(`${host.url}/host/execMachine`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  [versionHeader]: version,
                },
                body: JSON.stringify({
                  machine,
                  argv: ["/bin/sh", "-c", `: >"${began}"; sleep 30`],
                }),
              }).then(
                (response) => response.status,
                () => 0
              )
          )
        );

        yield* read(began).pipe(
          Effect.retry(Schedule.spaced(Duration.millis(20)))
        );

        const [took] = yield* Effect.timed(host.dispose);

        expect(Duration.toMillis(took)).toBeLessThan(1000);
        expect(yield* Fiber.join(exec)).not.toBe(200);
        expect(errors).toStrictEqual([]);
      })
  );

  it.effect(
    "a host whose runtime keeps no checkpoint as files refuses a builds setting, naming both, before its runtime starts anything",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const calls: string[] = [];

        const failure = yield* refused(
          {
            ...hostConfig(dir),
            builds: {
              endpoint: "http://127.0.0.1:8333",
              bucket: "builds",
              region: "us-east-1",
              accessKeyId: "id",
              secretAccessKey: Redacted.make("secret"),
            },
          },
          dir,
          "fixed",
          calls
        );

        expect(calls).toStrictEqual([]);
        expect(failure._tag).toBe("CannotStart");
        expect(failure.message).toContain("builds");
        expect(failure.message).toContain("fixed");
      })
  );

  it.effect("a host whose address is taken says where it couldn't listen", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const { url } = yield* started({ dir });
      const port = Number(new URL(url).port);

      const failure = yield* refused(
        { ...hostConfig(dir), listen: { address: "127.0.0.1", port } },
        dir
      );

      expect(failure._tag).toBe("Internal");
      expect(failure.message).toContain(`couldn't listen on 127.0.0.1:${port}`);
    })
  );
});

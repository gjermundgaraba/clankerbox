import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Layer, Logger } from "effect";
import { expect } from "vite-plus/test";

import { hostLayer } from "../../src/composition/host.ts";
import type { HostSettings } from "../../src/settings.ts";
import { fakeRuntime } from "../fake-runtime.ts";
import { hostConfig, hostOn, loopbackServer, noHttp } from "../support.ts";

const started = hostOn({ first: 21_140, last: 21_149 });

const refused = (settings: HostSettings, dir: string) =>
  Effect.flip(
    Layer.build(
      hostLayer(
        settings,
        fakeRuntime({ dir }).layer,
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
          scope: "machine dev",
          sequence: 1,
          step: {
            _tag: "remove",
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

import path from "node:path";

import type { Operation } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { writeTailscaleStubs } from "./fake-runtime.ts";
import { hostOn } from "./support.ts";

const host = hostOn({ first: 21_120, last: 21_129 });

const joinsTailnet = Effect.gen(function* () {
  const dir = yield* scratch;

  yield* Effect.sync(() => {
    writeTailscaleStubs(path.join(dir, "bin"));
  });

  return dir;
});

const tailscaleApi = (minted: string[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((sent, url) =>
      Effect.sync(() => {
        const key = `tskey-auth-api-${minted.length + 1}`;
        const token = url.pathname.endsWith("/oauth/token");

        if (!token) {
          minted.push(key);
        }

        return HttpClientResponse.fromWeb(
          sent,
          Response.json(token ? { access_token: "access-1" } : { id: "k", key })
        );
      })
    )
  );

const instance = "0123456789abcdef0123456789abcdef";

const sizes = { cpu: 1, ramMib: 1024, diskGib: 10 };

const make: Operation = {
  id: "make",
  scope: "machine dev",
  sequence: 1,
  step: {
    _tag: "make",
    machine: { name: "dev", instance, ...sizes },
    source: { _tag: "base", base: "ubuntu" },
    ports: [],
    machines: [],
  },
};

const join = (port: number): Operation => ({
  id: "join",
  scope: "machine dev",
  sequence: 2,
  step: {
    _tag: "join",
    machine: { name: "dev", instance, ...sizes, port },
    hostname: "linux-dev",
  },
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a host whose config has a tailnet mints through Tailscale's API, and joins",
    () =>
      Effect.gen(function* () {
        const minted: string[] = [];

        const { fake, operations } = yield* host({
          dir: yield* joinsTailnet,
          tailnetSettings: {
            oauthClient: { id: "k1", secret: Redacted.make("tskey-client-k1") },
            tags: ["tag:clankerbox-machine"],
          },
          http: tailscaleApi(minted),
        });

        const { outcome } = yield* operations.run(make);

        yield* operations.wait("make");
        yield* operations.run(join(outcome.port ?? 0));

        const report = yield* operations.wait("join");

        expect(report.outcome.tailnet).toStrictEqual({
          state: "joined",
          name: "linux-dev.example.ts.net",
        });
        expect(minted).toStrictEqual(["tskey-auth-api-1"]);
        expect(
          yield* read(
            path.join(fake.machines.get("dev")?.root ?? "", "key-seen")
          )
        ).toBe("tskey-auth-api-1");
      })
  );
});

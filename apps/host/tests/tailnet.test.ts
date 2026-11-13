import path from "node:path";

import type { Operation } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Layer, Redacted, Schema } from "effect";
import type { HttpBody } from "effect/http";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

import type { TailnetSettings } from "../src/platform/tailscale.ts";
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

const KeyRequest = Schema.fromJsonString(
  Schema.Struct({
    capabilities: Schema.Struct({
      devices: Schema.Struct({
        create: Schema.Struct({ tags: Schema.Array(Schema.String) }),
      }),
    }),
  })
);

const tagsOf = (body: HttpBody.HttpBody) =>
  body._tag === "Uint8Array"
    ? Schema.decodeUnknownSync(KeyRequest)(body.text).capabilities.devices
        .create.tags
    : [];

const tailscaleApi = (
  minted: string[],
  tagged: Array<readonly string[]> = []
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((sent, url) =>
      Effect.sync(() => {
        const key = `tskey-auth-api-${minted.length + 1}`;
        const token = url.pathname.endsWith("/oauth/token");

        if (!token) {
          minted.push(key);
          tagged.push(tagsOf(sent.body));
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

const make: Omit<Operation, "boot"> = {
  id: "make",
  scope: { resource: "machine", name: "dev" },
  sequence: 1,
  step: {
    _tag: "make",
    machine: { name: "dev", instance, ...sizes },
    source: { _tag: "base", base: "ubuntu" },
    taken: [],
    machines: [],
  },
};

const join: Omit<Operation, "boot"> = {
  id: "join",
  scope: { resource: "machine", name: "dev" },
  sequence: 2,
  step: {
    _tag: "join",
    machine: { name: "dev", instance, ...sizes },
    hostname: "linux-dev",
  },
};

const build: Omit<Operation, "boot"> = {
  id: "build",
  scope: { resource: "machine", name: "building-1" },
  sequence: 1,
  step: {
    _tag: "make",
    machine: {
      name: "building-1",
      instance: `b${instance.slice(1)}`,
      ...sizes,
    },
    source: {
      _tag: "base",
      base: "ubuntu",
      setup: { script: "#!/bin/sh\necho set up\n" },
    },
    join: { hostname: "cbx-building-1" },
    taken: [],
    machines: [],
  },
};

const client = {
  oauthClient: { id: "k1", secret: Redacted.make("tskey-client-k1") },
  tags: ["tag:clankerbox-machine"] as const,
};

const keysOf = (tailnetSettings: TailnetSettings) =>
  Effect.gen(function* () {
    const tagged: Array<readonly string[]> = [];

    const { operations } = yield* host({
      dir: yield* joinsTailnet,
      tailnetSettings,
      http: tailscaleApi([], tagged),
    });

    yield* operations.run({ ...build, boot: operations.boot });

    const built = yield* operations.wait("build");

    expect(built.status, built.error?.message).toBe("done");

    yield* operations.run({ ...make, boot: operations.boot });
    yield* operations.wait("make");
    yield* operations.run({ ...join, boot: operations.boot });
    yield* operations.wait("join");

    return tagged;
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

        yield* operations.run({ ...make, boot: operations.boot });
        yield* operations.wait("make");
        yield* operations.run({ ...join, boot: operations.boot });

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

  it.effect(
    "a builder's key carries the tailnet's buildTags, and a machine's its tags",
    () =>
      Effect.gen(function* () {
        expect(
          yield* keysOf({ ...client, buildTags: ["tag:clankerbox-build"] })
        ).toStrictEqual([["tag:clankerbox-build"], ["tag:clankerbox-machine"]]);
      })
  );

  it.effect(
    "a builder's key carries the tags when there are no buildTags",
    () =>
      Effect.gen(function* () {
        expect(yield* keysOf(client)).toStrictEqual([
          ["tag:clankerbox-machine"],
          ["tag:clankerbox-machine"],
        ]);
      })
  );
});

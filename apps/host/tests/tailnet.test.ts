import path from "node:path";

import type { Operation } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  mkdir,
  outputOf,
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Layer, Redacted, Schema } from "effect";
import type { HttpBody } from "effect/http";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { tailnetIn, tailnetScript } from "../src/guest.ts";
import type { TailnetSettings } from "../src/platform/tailscale.ts";
import { furnish, writeStubs, writeTailscaleStubs } from "./fake-runtime.ts";
import { hostOn, suitePorts } from "./support.ts";

const host = hostOn(suitePorts.tailnet);

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

const starting = (sequence: number): Omit<Operation, "boot"> => ({
  id: `start-${sequence}`,
  scope: { resource: "machine", name: "dev" },
  sequence,
  step: {
    _tag: "start",
    keep: [],
    machine: { name: "dev", instance, ...sizes },
    machines: [],
  },
});

const stopping = (sequence: number): Omit<Operation, "boot"> => ({
  id: `stop-${sequence}`,
  scope: { resource: "machine", name: "dev" },
  sequence,
  step: {
    _tag: "stop",
    machine: { name: "dev", instance, ...sizes },
    machines: [],
  },
});

const joinedAgain = (sequence: number): Omit<Operation, "boot"> => ({
  ...join,
  id: `join-${sequence}`,
  sequence,
});

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

const nodeState = path.join(
  "var",
  "lib",
  "clankerbox",
  "tailscale",
  "state",
  "tailscaled.state"
);

const restartedAfter = (fault: "node-removed" | "control-unreachable") =>
  Effect.gen(function* () {
    const minted: string[] = [];

    const { fake, operations } = yield* host({
      dir: yield* joinsTailnet,
      tailnetSettings: client,
      http: tailscaleApi(minted),
    });

    const run = (operation: Omit<Operation, "boot">) =>
      Effect.andThen(
        operations.run({ ...operation, boot: operations.boot }),
        Effect.repeat(operations.wait(operation.id), {
          until: (report) => report.status !== "running",
        })
      );

    const done = (operation: Omit<Operation, "boot">) =>
      Effect.tap(run(operation), (report) =>
        Effect.sync(() => {
          expect(report.status, report.error?.message).toBe("done");
        })
      );

    yield* done(make);
    yield* done(starting(2));
    yield* done(joinedAgain(3));

    const root = fake.machines.get("dev")?.root ?? "";

    yield* mkdir(path.dirname(path.join(root, nodeState)));
    yield* write(path.join(root, nodeState), "the first node\n");
    yield* write(path.join(root, fault), "");
    yield* done(stopping(4));
    yield* done(starting(5));

    const rejoined = yield* done(joinedAgain(6));

    return {
      minted,
      root,
      tailnet: rejoined.outcome.tailnet,
      again: done(joinedAgain(7)),
    };
  });

const removedNode =
  "Received error: PollNetMap: initial fetch failed 404: node not found\n";

const nodeWhose = (self: { readonly online: boolean }) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const root = path.join(dir, "root");
    const bin = writeStubs(dir, "Linux");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    yield* mkdir(path.join(root, "dev"));
    furnish(root, bin);
    writeTailscaleStubs(bin);

    const daemon = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-c", "while :; do sleep 0.05; done"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGKILL",
      })
    );

    const pid = String(daemon.pid);
    const state = path.join(root, "var", "lib", "clankerbox", "tailscale");

    yield* mkdir(path.join(state, "state"));
    yield* write(path.join(state, "state", "tailscaled.state"), "{}\n");
    yield* write(path.join(state, "tailscaled.pid"), `${pid}\n`);
    yield* write(path.join(state, "tailscaled.log"), removedNode);
    yield* mkdir(path.join(root, "proc", pid));
    yield* write(path.join(root, "proc", pid, "comm"), "tailscaled\n");
    yield* write(path.join(root, "daemon"), "");
    yield* write(
      path.join(root, "status.json"),
      `{"BackendState": "Running", "Self": {"DNSName": "linux-dev.example.ts.net.", "Online": ${self.online}}}\n`
    );

    const { stdout } = yield* outputOf(
      "/bin/sh",
      ["-c", tailnetScript, "tailnet", "linux-dev", "user"],
      {
        env: { CLANKERBOX_ROOT: root, PATH: "/nowhere" },
        extendEnv: true,
        input: new TextEncoder().encode(""),
      }
    );

    return tailnetIn(stdout);
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a node online now is reported as it is, whatever 404 its daemon logged before",
    () =>
      Effect.gen(function* () {
        expect(yield* nodeWhose({ online: true })).toStrictEqual({
          state: "reported",
          backend: "Running",
          name: "linux-dev.example.ts.net",
        });
        expect(yield* nodeWhose({ online: false })).toStrictEqual({
          state: "lost",
        });
      }),
    30_000
  );

  it.effect(
    "a machine whose node was removed ends joined under a new node after its next start",
    () =>
      Effect.gen(function* () {
        const { minted, root, tailnet, again } =
          yield* restartedAfter("node-removed");

        expect(tailnet).toStrictEqual({
          state: "joined",
          name: "linux-dev.example.ts.net",
        });
        expect(minted).toStrictEqual(["tskey-auth-api-1", "tskey-auth-api-2"]);
        expect(yield* read(path.join(root, "key-seen"))).toBe(
          "tskey-auth-api-2"
        );
        expect(
          yield* Effect.exit(read(path.join(root, nodeState)))
        ).toMatchObject({ _tag: "Failure" });

        const next = yield* again;

        expect(next.outcome.tailnet).toMatchObject({ state: "joined" });
        expect(minted).toHaveLength(2);
      })
  );

  it.effect(
    "a machine whose control server is unreachable keeps its node",
    () =>
      Effect.gen(function* () {
        const { minted, root, tailnet } = yield* restartedAfter(
          "control-unreachable"
        );

        expect(tailnet).toStrictEqual({
          state: "joined",
          name: "linux-dev.example.ts.net",
        });
        expect(minted).toStrictEqual(["tskey-auth-api-1"]);
        expect(yield* read(path.join(root, nodeState))).toBe(
          "the first node\n"
        );
      }),
    30_000
  );

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

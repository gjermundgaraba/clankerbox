import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Internal, type Machine } from "@gjermundgaraba/clankerbox-sdk";
import { read, scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";
import { Deferred, Duration, Effect, Layer, Redacted, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";
import { Tailnet } from "../src/tailnet.ts";
import { writeTailscaleStubs } from "./fake-runtime.ts";
import { eventually, hostOn, request, type TestHost } from "./support.ts";

const host = hostOn({ first: 21_120, last: 21_129 });

const minting = (failures = 0) =>
  Effect.gen(function* () {
    const minted = yield* Ref.make(0);
    const failing = yield* Ref.make(failures);

    const tailnet = Layer.succeed(Tailnet, {
      mint: Effect.gen(function* () {
        if ((yield* Ref.getAndUpdate(failing, (left) => left - 1)) > 0) {
          return yield* new Internal({ message: "Tailscale refused the OAuth client" });
        }

        const count = yield* Ref.updateAndGet(minted, (all) => all + 1);

        return Redacted.make(`tskey-auth-${count}`);
      }),
    });

    return { tailnet, minted: Ref.get(minted) };
  });

const joinsTailnet = Effect.gen(function* () {
  const dir = yield* scratch;

  yield* Effect.sync(() => writeTailscaleStubs(join(dir, "bin")));

  return dir;
});

const tailscaleApi = (minted: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const key = `tskey-auth-api-${minted.length + 1}`;
        const token = url.pathname.endsWith("/oauth/token");

        if (!token) {
          minted.push(key);
        }

        return HttpClientResponse.fromWeb(
          request,
          Response.json(token ? { access_token: "access-1" } : { id: "k", key }),
        );
      }),
    ),
  );

const runningStatus = (health: ReadonlyArray<string>) =>
  JSON.stringify(
    {
      BackendState: "Running",
      Health: health,
      Self: { ID: "n2", DNSName: "linux-dev.example.ts.net." },
    },
    undefined,
    2,
  );

const checked = (linux: TestHost, id = "linux_dev") =>
  eventually(
    linux.run(linux.machines.get(id)),
    (machine: Machine) => machine.tailnet !== undefined,
  );

const unchecked = (linux: TestHost, id = "linux_dev") =>
  Effect.andThen(Effect.sleep(Duration.millis(300)), linux.run(linux.machines.get(id)));

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a machine that needs a login gets one minted key, and shows the DNS name it joined as",
    () =>
      Effect.gen(function* () {
        const keys = yield* minting();
        const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

        yield* linux.run(linux.machines.create(request("dev")));

        const machine = yield* checked(linux);

        expect(machine.tailnet).toEqual({ state: "joined", name: "linux-dev.example.ts.net" });
        expect(yield* keys.minted).toBe(1);
        expect(yield* read(join(linux.fake.machines.get("dev")?.root ?? "", "key-seen"))).toBe(
          "tskey-auth-1",
        );
      }),
  );

  it.effect("a create answers before its join is done, which get shows once it is", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();

      const tailnet = Layer.succeed(Tailnet, {
        mint: Effect.as(Deferred.await(release), Redacted.make("tskey-auth-held")),
      });

      const linux = yield* host({ dir: yield* joinsTailnet, tailnet });
      const created = yield* linux.run(linux.machines.create(request("dev")));

      expect([created.state, created.phase, created.tailnet]).toEqual([
        "running",
        "settled",
        undefined,
      ]);

      yield* Deferred.succeed(release, undefined);

      expect((yield* checked(linux)).tailnet).toEqual({
        state: "joined",
        name: "linux-dev.example.ts.net",
      });
    }),
  );

  it.effect("a start whose tailscaled is still signed in mints nothing", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("dev")));
      yield* checked(linux);
      yield* linux.run(linux.machines.start("linux_dev"));

      const again = yield* checked(linux);

      expect(again.tailnet).toEqual({ state: "joined", name: "linux-dev.example.ts.net" });
      expect(yield* keys.minted).toBe(1);
    }),
  );

  it.effect("a join that fails leaves the machine running and shows why", () =>
    Effect.gen(function* () {
      const keys = yield* minting(1);
      const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("dev")));

      const machine = yield* checked(linux);

      expect([machine.state, machine.phase]).toEqual(["running", "settled"]);
      expect(machine.tailnet).toEqual({
        state: "failed",
        error: "Tailscale refused the OAuth client",
      });
    }),
  );

  it.effect("a recheck that finds a failed join running joins it again", () =>
    Effect.gen(function* () {
      const keys = yield* minting(1);

      const linux = yield* host({
        dir: yield* joinsTailnet,
        tailnet: keys.tailnet,
        recheck: Duration.millis(100),
      });

      yield* linux.run(linux.machines.create(request("dev")));

      const joined = yield* eventually(
        linux.run(linux.machines.get("linux_dev")),
        (machine: Machine) => machine.tailnet?.state === "joined",
      );

      expect(joined.tailnet).toEqual({ state: "joined", name: "linux-dev.example.ts.net" });
      expect(yield* keys.minted).toBe(1);
    }),
  );

  it.effect("a guest without tailscaled shows it missing, and no key is minted", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const linux = yield* host({ tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("dev")));

      expect((yield* checked(linux)).tailnet).toEqual({ state: "missing" });
      expect(yield* keys.minted).toBe(0);
    }),
  );

  it.effect("a prebuild's builder joins no tailnet", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("builder"), { ephemeral: true }));

      expect((yield* unchecked(linux, "linux_builder")).tailnet).toBeUndefined();
      expect(yield* keys.minted).toBe(0);
    }),
  );

  it.effect("a host that joins no tailnet shows no tailnet on its machines", () =>
    Effect.gen(function* () {
      const linux = yield* host({ dir: yield* joinsTailnet });

      yield* linux.run(linux.machines.create(request("dev")));

      expect((yield* unchecked(linux)).tailnet).toBeUndefined();
    }),
  );

  it.effect("a stopped machine shows no tailnet", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("dev")));
      yield* checked(linux);

      const stopped = yield* linux.run(linux.machines.stop("linux_dev"));

      expect(stopped.tailnet).toBeUndefined();
    }),
  );

  it.effect("a host whose config has a tailnet mints through Tailscale's API, and joins", () =>
    Effect.gen(function* () {
      const minted: Array<string> = [];

      const linux = yield* host({
        dir: yield* joinsTailnet,
        tailnetSettings: {
          oauthClient: { id: "k1", secret: Redacted.make("tskey-client-k1") },
          tags: ["tag:clankerbox-machine"],
        },
        http: tailscaleApi(minted),
      });

      yield* linux.run(linux.machines.create(request("dev")));

      expect((yield* checked(linux)).tailnet).toEqual({
        state: "joined",
        name: "linux-dev.example.ts.net",
      });
      expect(minted).toEqual(["tskey-auth-api-1"]);
      expect(yield* read(join(linux.fake.machines.get("dev")?.root ?? "", "key-seen"))).toBe(
        "tskey-auth-api-1",
      );
    }),
  );

  it.effect("a status longer than an error's tail still reads whole", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("dev")));
      yield* checked(linux);

      const status = runningStatus(
        Array.from({ length: 60 }, (_, at) => `${at} ${"w".repeat(180)}`),
      );

      expect(status.length).toBeGreaterThan(10_000);

      yield* write(join(linux.fake.machines.get("dev")?.root ?? "", "status.json"), status);
      yield* linux.run(linux.machines.start("linux_dev"));

      expect((yield* checked(linux)).tailnet).toEqual({
        state: "joined",
        name: "linux-dev.example.ts.net",
      });
    }),
  );

  it.effect("a machine stopped outside the host shows no tailnet", () =>
    Effect.gen(function* () {
      const keys = yield* minting();
      const linux = yield* host({ dir: yield* joinsTailnet, tailnet: keys.tailnet });

      yield* linux.run(linux.machines.create(request("dev")));
      yield* checked(linux);

      const fake = linux.fake.machines.get("dev");

      if (fake !== undefined) {
        fake.state = "stopped";
      }

      const seen = yield* linux.run(linux.machines.get("linux_dev"));

      expect([seen.state, seen.tailnet]).toEqual(["stopped", undefined]);
    }),
  );
});

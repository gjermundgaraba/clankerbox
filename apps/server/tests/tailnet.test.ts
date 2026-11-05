import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "@effect/vitest";
import type { Machine, TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Duration, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  checked,
  due,
  firstCheck,
  longestBackoff,
  ticked,
  unchecked,
} from "../src/tailnet.ts";
import {
  addsLoginUser,
  clientOf,
  eventually,
  loginSetup,
  pause,
  plane,
  request,
  running,
} from "./support.ts";

const failed: TailnetStatus = { state: "failed", error: "no answer" };

const joinedName = { state: "joined", name: "linux-dev.example.ts.net" };

const tailscaleApi = (
  minted: string[],
  options?: {
    readonly refuse?: { count: number };
    readonly hold?: Deferred.Deferred<undefined>;
    readonly entered?: Deferred.Deferred<undefined>;
  }
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((sent, url) =>
      Effect.gen(function* () {
        const token = url.pathname.endsWith("/oauth/token");

        if (options?.entered !== undefined) {
          yield* Deferred.succeed(options.entered, undefined);
        }

        if (options?.hold !== undefined) {
          yield* Deferred.await(options.hold);
        }

        if (options?.refuse !== undefined && options.refuse.count > 0) {
          options.refuse.count -= 1;

          return HttpClientResponse.fromWeb(
            sent,
            new Response("refused", { status: 401 })
          );
        }

        const key = `tskey-auth-api-${minted.length + 1}`;

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

const joining = (
  http: Layer.Layer<HttpClient.HttpClient>,
  options?: Parameters<typeof running>[0]
) => ({
  tailscaled: true,
  ...options,
  runtime: {
    tailnetSettings: {
      oauthClient: { id: "k1", secret: Redacted.make("tskey-client-k1") },
      tags: ["tag:clankerbox-machine"] as const,
    },
    http,
    ...options?.runtime,
  },
});

const served = (options?: Parameters<typeof running>[0]) =>
  Effect.gen(function* () {
    const plan = yield* running(options);
    const client = yield* clientOf(plan.url);
    const asking = yield* clientOf(plan.url, { noWait: true });
    const shown = (id = "dev") => client.getMachine({ id });

    return {
      ...plan,
      client,
      asking,
      shown,
      tailnetOf: (id = "dev") =>
        eventually(
          shown(id),
          (machine: Machine) => machine.tailnet !== undefined
        ),
    };
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  describe("a tailnet check", () => {
    it.effect(
      "is due once a machine runs, and not before anything asks for it",
      () =>
        Effect.sync(() => {
          expect([due(unchecked), due(firstCheck)]).toStrictEqual([
            false,
            true,
          ]);
        })
    );

    it.effect(
      "each failure in a row doubles the rechecks the next check waits, up to a cap",
      () =>
        Effect.sync(() => {
          let check = checked(firstCheck, failed);
          const waits = [check.wait];

          for (let failures = 1; failures < 9; failures += 1) {
            check = checked(check, failed);
            waits.push(check.wait);
          }

          expect(waits).toStrictEqual([
            1,
            2,
            4,
            8,
            16,
            32,
            longestBackoff,
            longestBackoff,
            longestBackoff,
          ]);
          expect(checked(check, { state: "joined" })).toMatchObject({
            wait: 60,
            backoff: 1,
          });
        })
    );

    it.effect("a failed check is due again after the rechecks it waits", () =>
      Effect.sync(() => {
        const failedOnce = checked(firstCheck, failed);
        const failedTwice = checked(failedOnce, failed);
        const afterOne = ticked(failedTwice);

        expect([due(failedOnce), due(ticked(failedOnce))]).toStrictEqual([
          false,
          true,
        ]);
        expect([due(afterOne), due(ticked(afterOne))]).toStrictEqual([
          false,
          true,
        ]);
      })
    );

    it.effect(
      "a machine without tailscaled, or a host that joins nothing, is never due again",
      () =>
        Effect.sync(() => {
          const missing = checked(firstCheck, { state: "missing" });
          const nothing = checked(firstCheck, undefined);

          expect([missing.wait, nothing.wait]).toStrictEqual([
            undefined,
            undefined,
          ]);
          expect([due(ticked(missing)), due(ticked(nothing))]).toStrictEqual([
            false,
            false,
          ]);
          expect(nothing).toStrictEqual({
            status: undefined,
            wait: undefined,
            backoff: 1,
          });
        })
    );

    it.effect(
      "a recheck leaves a check that is due as it is, until it runs",
      () =>
        Effect.sync(() => {
          expect(due(ticked(firstCheck))).toBe(true);
        })
    );
  });

  it.effect("a create answers settled, then joins in its own step", () =>
    Effect.gen(function* () {
      const minted: string[] = [];
      const hold = yield* Deferred.make<undefined>();
      const entered = yield* Deferred.make<undefined>();

      const { client, hosts, shown, store } = yield* served(
        joining(tailscaleApi(minted, { hold, entered }))
      );

      yield* client.buildTemplate({
        ...request("unused"),
        template: "web",
        setup: { script: `#!/bin/sh\n${loginSetup}`, timeoutSeconds: 30 },
      });

      const created = yield* client.create("box", { template: "web" });

      yield* Deferred.await(entered);

      const joiningNow = yield* store.operationOn("machine", "box");

      expect([created.state, created.phase, created.tailnet]).toStrictEqual([
        "running",
        "settled",
        undefined,
      ]);
      expect(Option.map(joiningNow, ({ kind }) => kind)).toStrictEqual(
        Option.some("join")
      );
      expect((yield* shown("box")).phase).toBe("settled");

      yield* Deferred.succeed(hold, undefined);

      const joined = yield* eventually(
        shown("box"),
        (machine: Machine) => machine.tailnet !== undefined
      );

      expect(joined.tailnet).toStrictEqual(joinedName);
      expect(minted).toHaveLength(1);
      expect(
        hosts[0]?.fake.calls.filter((call) => call.endsWith(" box"))
      ).toStrictEqual([
        "admit box",
        "restore box",
        "exec box",
        "exec box",
        "exec box",
        "exec box",
        "exec box",
      ]);
    })
  );

  it.effect(
    "a start checks a machine again, minting nothing while it stays joined",
    () =>
      Effect.gen(function* () {
        const minted: string[] = [];

        const { client, tailnetOf } = yield* served(
          joining(tailscaleApi(minted))
        );

        yield* client.create("dev", request("dev"));
        yield* tailnetOf();
        yield* client.startMachine({ id: "dev" });

        expect((yield* tailnetOf()).tailnet).toStrictEqual(joinedName);
        expect(minted).toHaveLength(1);
      })
  );

  it.effect("a join that fails leaves the machine running and shows why", () =>
    Effect.gen(function* () {
      const { client, tailnetOf } = yield* served(
        joining(tailscaleApi([], { refuse: { count: 1 } }))
      );

      yield* client.create("dev", request("dev"));

      const machine = yield* tailnetOf();

      expect([machine.state, machine.phase]).toStrictEqual([
        "running",
        "settled",
      ]);
      expect(machine.tailnet?.state).toBe("failed");
    })
  );

  it.effect("a recheck joins again a machine whose join failed", () =>
    Effect.gen(function* () {
      const minted: string[] = [];

      const { client, shown } = yield* served(
        joining(tailscaleApi(minted, { refuse: { count: 1 } }), {
          recheck: Duration.millis(100),
        })
      );

      yield* client.create("dev", request("dev"));

      const joined = yield* eventually(
        shown(),
        (machine: Machine) => machine.tailnet?.state === "joined"
      );

      expect(joined.tailnet).toStrictEqual(joinedName);
      expect(minted).toHaveLength(1);
    })
  );

  it.effect(
    "a guest without tailscaled shows it missing, and isn't checked again until it starts again",
    () =>
      Effect.gen(function* () {
        const minted: string[] = [];

        const { client, hosts, tailnetOf } = yield* served({
          ...joining(tailscaleApi(minted), {
            recheck: Duration.millis(50),
          }),
          tailscaled: false,
        });

        yield* client.create("dev", request("dev"));

        expect((yield* tailnetOf()).tailnet).toStrictEqual({
          state: "missing",
        });

        const execs = () =>
          hosts[0]?.fake.calls.filter((call) => call === "exec dev").length;

        const before = execs();

        yield* Effect.sleep(Duration.millis(300));

        expect(execs()).toBe(before);
        expect(minted).toStrictEqual([]);
      })
  );

  it.effect("a template's builder joins no tailnet", () =>
    Effect.gen(function* () {
      const minted: string[] = [];
      const { client } = yield* served(joining(tailscaleApi(minted)));

      yield* client.buildTemplate({
        ...request("unused"),
        template: "web",
        setup: {
          script: `#!/bin/sh\n${addsLoginUser}\necho set up\n`,
          timeoutSeconds: 30,
        },
      });
      yield* Effect.sleep(Duration.millis(200));

      expect(minted).toStrictEqual([]);
    })
  );

  it.effect(
    "a host that joins no tailnet shows no tailnet on its machines",
    () =>
      Effect.gen(function* () {
        const { client, shown } = yield* served({ tailscaled: true });

        yield* client.create("dev", request("dev"));

        yield* Effect.sleep(Duration.millis(300));

        expect((yield* shown()).tailnet).toBeUndefined();
      })
  );

  it.effect("a stopped machine shows no tailnet", () =>
    Effect.gen(function* () {
      const { client, tailnetOf } = yield* served(joining(tailscaleApi([])));

      yield* client.create("dev", request("dev"));
      yield* tailnetOf();

      const stopped = yield* client.stopMachine({ id: "dev" });

      expect(stopped.tailnet).toBeUndefined();
    })
  );

  it.effect(
    "a machine stopped outside the control plane shows no tailnet",
    () =>
      Effect.gen(function* () {
        const { client, hosts, shown, tailnetOf } = yield* served(
          joining(tailscaleApi([]))
        );

        yield* client.create("dev", request("dev"));
        yield* tailnetOf();

        for (const held of hosts[0]?.fake.machines.values() ?? []) {
          held.state = "stopped";
        }

        const seen = yield* shown();

        expect([seen.state, seen.tailnet]).toStrictEqual([
          "stopped",
          undefined,
        ]);
      })
  );

  it.effect(
    "a stop sent while a machine joins cuts the join short, and is the answer",
    () =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<undefined>();

        const { client, asking, hosts, store } = yield* served(
          joining(tailscaleApi([], { hold }))
        );

        yield* asking.create("dev", request("dev"));
        yield* eventually(
          store.operationOn("machine", "dev"),
          (found) => found._tag === "Some" && found.value.kind === "join"
        );
        yield* pause;

        const stopped = yield* client.stopMachine({ id: "dev" });

        expect([stopped.state, stopped.phase]).toStrictEqual([
          "stopped",
          "settled",
        ]);
        expect(hosts[0]?.fake.machines.get("dev")?.state).toBe("stopped");
      })
  );

  it.effect(
    "a machine asked to stop is stopped, not joined, when it runs again",
    () =>
      Effect.gen(function* () {
        const minted: string[] = [];

        const { client, hosts } = yield* served(
          joining(tailscaleApi(minted, { refuse: { count: 1 } }), {
            recheck: Duration.millis(100),
          })
        );

        yield* client.create("dev", request("dev"));
        yield* client.stopMachine({ id: "dev" });

        const [host] = hosts;

        for (const held of host?.fake.machines.values() ?? []) {
          held.state = "running";
        }

        yield* eventually(
          Effect.sync(() => host?.fake.machines.get("dev")?.state),
          (state) => state === "stopped"
        );

        expect(minted).toStrictEqual([]);
      })
  );

  it.effect(
    "a control plane that restarts checks a running machine again, so it shows its tailnet",
    () =>
      Effect.gen(function* () {
        const minted: string[] = [];
        const planned = yield* plane(joining(tailscaleApi(minted)));
        const first = yield* planned.start();
        const client = yield* clientOf(first.url);

        yield* client.create("dev", request("dev"));
        yield* eventually(
          client.getMachine({ id: "dev" }),
          (machine) => machine.tailnet !== undefined
        );
        yield* first.crash;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        const again = yield* clientOf(second.url);

        expect(
          (yield* eventually(
            again.getMachine({ id: "dev" }),
            (machine) => machine.tailnet !== undefined
          )).tailnet
        ).toStrictEqual(joinedName);
        expect(minted).toHaveLength(1);
      })
  );
});

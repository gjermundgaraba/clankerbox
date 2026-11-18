import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "@effect/vitest";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine, TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { read } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Deferred, Duration, Effect, Option, Redacted } from "effect";

import {
  checked,
  due,
  firstCheck,
  longestBackoff,
  started,
  ticked,
  unchecked,
} from "../src/tailnet.ts";
import type { Tailnet } from "../src/tailnet.ts";
import {
  clientOf,
  eventually,
  hostKeySetup,
  plane,
  request,
  restartedHost,
  running,
} from "./support.ts";

const failed: TailnetStatus = { state: "failed", error: "no answer" };

const tailnetSetup = [
  "#!/bin/sh",
  'tailscale --socket="$CLANKERBOX_ROOT/var/lib/clankerbox/tailscale/tailscaled.sock" status --json >"$HOME/tailnet-status" || true',
  "",
].join("\n");

const joinedName = { state: "joined", name: "linux-dev.example.ts.net" };

const minting = (options?: {
  readonly refuse?: { count: number };
  readonly hold?: Deferred.Deferred<undefined>;
  readonly entered?: Deferred.Deferred<undefined>;
  readonly holdingAfter?: number;
}) => {
  const minted: string[] = [];
  const begun = { count: 0 };

  const mint = (kind: "machine" | "build") =>
    Effect.gen(function* () {
      begun.count += 1;

      const holding = minted.length >= (options?.holdingAfter ?? 0);

      if (holding && options?.entered !== undefined) {
        yield* Deferred.succeed(options.entered, undefined);
      }

      if (holding && options?.hold !== undefined) {
        yield* Deferred.await(options.hold);
      }

      if (options?.refuse !== undefined && options.refuse.count > 0) {
        options.refuse.count -= 1;

        return yield* new Internal({
          message: "Tailscale refused the OAuth client",
        });
      }

      const key = `tskey-auth-${kind}-${minted.length + 1}`;

      minted.push(key);

      return Redacted.make(key);
    });

  const tailnet: Tailnet["Service"] = {
    mint: mint("machine"),
    mintBuild: mint("build"),
  };

  return { minted, begun, tailnet };
};

const joining = (
  tailnet: Tailnet["Service"],
  options?: Parameters<typeof running>[0]
) => ({
  tailscaled: true,
  tailnet,
  ...options,
  runtime: { tailnet: true, ...options?.runtime },
});

const onTailnet = (name: string) => request(name, { tailnet: true });

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
          (machine: Machine) =>
            machine.tailnet !== undefined && machine.tailnet.state !== "pending"
        ),
    };
  });

const keySeen = (root: string | undefined) =>
  read(path.join(root ?? "", "key-seen"));

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  describe("a tailnet check", () => {
    it.effect(
      "is due once a machine runs, and not before anything asks for it",
      () =>
        Effect.sync(() => {
          expect([due(unchecked), due(firstCheck), due(started)]).toStrictEqual(
            [false, true, true]
          );
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
      "a check carries a key after a start or a failure, and not after a restart or a join",
      () =>
        Effect.sync(() => {
          expect([
            firstCheck.keyed,
            started.keyed,
            checked(firstCheck, failed).keyed,
            checked(started, { state: "joined" }).keyed,
            checked(started, { state: "missing" }).keyed,
          ]).toStrictEqual([false, true, true, false, false]);
        })
    );

    it.effect(
      "a machine without tailscaled, or a host that reports nothing, is never due again",
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
          expect(nothing).toStrictEqual(unchecked);
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

  it.effect(
    "a template's clone answers settled, then joins in its own step",
    () =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<undefined>();
        const entered = yield* Deferred.make<undefined>();
        const { minted, tailnet } = minting({ hold, entered, holdingAfter: 1 });

        const { client, hosts, shown, store } = yield* served(joining(tailnet));

        yield* client.buildTemplate({
          ...request("unused"),
          template: "web",
          tailnet: true,
          setup: { script: `#!/bin/sh\n${hostKeySetup}`, timeoutSeconds: 30 },
        });

        expect(minted).toStrictEqual(["tskey-auth-build-1"]);

        const created = yield* client.create("box", { template: "web" });

        yield* Deferred.await(entered);

        const joiningNow = yield* store.operationOn("machine", "box");

        expect([created.state, created.phase, created.tailnet]).toStrictEqual([
          "running",
          "settled",
          { state: "pending" },
        ]);
        expect(Option.map(joiningNow, ({ kind }) => kind)).toStrictEqual(
          Option.some("join")
        );
        expect((yield* shown("box")).phase).toBe("settled");

        yield* Deferred.succeed(hold, undefined);

        const joined = yield* eventually(
          shown("box"),
          (machine: Machine) => machine.tailnet?.state === "joined"
        );

        expect(joined.tailnet).toStrictEqual(joinedName);
        expect(minted).toStrictEqual([
          "tskey-auth-build-1",
          "tskey-auth-machine-2",
        ]);
        expect(yield* keySeen(hosts[0]?.fake.root("box"))).toBe(
          "tskey-auth-machine-2"
        );
      })
  );

  it.effect(
    "a start checks a machine again with a key, which a node still signed in leaves unused",
    () =>
      Effect.gen(function* () {
        const { minted, tailnet } = minting();

        const { client, hosts, tailnetOf } = yield* served(joining(tailnet));

        yield* client.create("dev", onTailnet("dev"));
        yield* tailnetOf();
        yield* client.stopMachine({ id: "dev" });
        yield* client.startMachine({ id: "dev" });

        expect((yield* tailnetOf()).tailnet).toStrictEqual(joinedName);
        expect(minted).toHaveLength(2);
        expect(yield* keySeen(hosts[0]?.fake.root("dev"))).toBe(minted[0]);
      })
  );

  it.effect(
    "a key the control plane can't mint fails the join, leaving the machine running, and shows why",
    () =>
      Effect.gen(function* () {
        const { tailnet } = minting({ refuse: { count: 1 } });
        const { client, tailnetOf } = yield* served(joining(tailnet));

        yield* client.create("dev", onTailnet("dev"));

        const machine = yield* tailnetOf();

        expect([machine.state, machine.phase]).toStrictEqual([
          "running",
          "settled",
        ]);
        expect(machine.tailnet).toMatchObject({ state: "failed" });
        expect(
          machine.tailnet?.state === "failed" ? machine.tailnet.error : ""
        ).toContain(
          "the control plane couldn't mint a tailnet key: Tailscale refused the OAuth client"
        );
      })
  );

  it.effect(
    "a host that says it joins but whose guest can't sign in fails the join, and shows why",
    () =>
      Effect.gen(function* () {
        const { tailnet } = minting();

        const { client, tailnetOf } = yield* served({
          ...joining(tailnet),
          tailscaled: "refuses",
        });

        yield* client.create("dev", onTailnet("dev"));

        const machine = yield* tailnetOf();

        expect(machine.state).toBe("running");
        expect(
          machine.tailnet?.state === "failed" ? machine.tailnet.error : ""
        ).toContain("invalid key");
      })
  );

  it.effect("a recheck joins again a machine whose join failed", () =>
    Effect.gen(function* () {
      const { minted, tailnet } = minting({ refuse: { count: 1 } });

      const { client, shown } = yield* served(
        joining(tailnet, { recheck: Duration.millis(100) })
      );

      yield* client.create("dev", onTailnet("dev"));

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
        const { tailnet } = minting();

        const { client, hosts, tailnetOf } = yield* served({
          ...joining(tailnet, { recheck: Duration.millis(50) }),
          tailscaled: false,
        });

        yield* client.create("dev", onTailnet("dev"));

        expect((yield* tailnetOf()).tailnet).toStrictEqual({
          state: "missing",
        });

        const execs = () =>
          hosts[0]?.fake.calls.filter((call) => call === "exec dev").length;

        const before = execs();

        yield* Effect.sleep(Duration.millis(300));

        expect(execs()).toBe(before);
      })
  );

  it.effect(
    "a template's builder joins the tailnet for its setup with a build key, and a clone of its build joins as its own node",
    () =>
      Effect.gen(function* () {
        const { minted, tailnet } = minting();

        const { client, hosts, tailnetOf } = yield* served(joining(tailnet));

        const built = yield* client.buildTemplate({
          ...request("unused"),
          template: "web",
          tailnet: true,
          setup: { script: tailnetSetup, timeoutSeconds: 30 },
        });

        expect(built.tailnet).toBe(true);
        expect(minted).toStrictEqual(["tskey-auth-build-1"]);

        yield* client.create("box", { template: "web" });

        expect((yield* tailnetOf("box")).tailnet).toStrictEqual(joinedName);
        expect(minted).toStrictEqual([
          "tskey-auth-build-1",
          "tskey-auth-machine-2",
        ]);
        expect(
          yield* read(
            path.join(
              hosts[0]?.fake.root("box") ?? "",
              "home/admin/tailnet-status"
            )
          )
        ).toContain('"BackendState": "Running"');
      })
  );

  it.effect(
    "a template that requests no tailnet builds and clones off it, minting nothing",
    () =>
      Effect.gen(function* () {
        const { minted, tailnet } = minting();
        const { client, hosts } = yield* served(joining(tailnet));

        const built = yield* client.buildTemplate({
          ...request("unused"),
          template: "web",
          setup: { script: tailnetSetup, timeoutSeconds: 30 },
        });

        const box = yield* client.create("box", { template: "web" });

        yield* Effect.sleep(Duration.millis(300));

        expect([built.phase, built.tailnet]).toStrictEqual([
          "ready",
          undefined,
        ]);
        expect(box.tailnet).toBeUndefined();
        expect(minted).toStrictEqual([]);
        expect(
          yield* read(
            path.join(
              hosts[0]?.fake.root("box") ?? "",
              "home/admin/tailnet-status"
            )
          )
        ).not.toContain("Running");
      })
  );

  it.effect(
    "a fork and a restore inherit their source's request, also once the source is deleted",
    () =>
      Effect.gen(function* () {
        const { tailnet } = minting();
        const { client, shown, tailnetOf } = yield* served(joining(tailnet));

        yield* client.create("dev", onTailnet("dev"));
        yield* client.create("plain", request("plain"));
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* client.forkMachine({ machine: "plain", name: "plain-copy" });
        yield* client.deleteMachine({ id: "dev" });
        yield* client.restoreMachine({ checkpoint: "snap", name: "back" });

        expect((yield* tailnetOf("back")).tailnet).toStrictEqual(joinedName);
        expect((yield* shown("plain-copy")).tailnet).toBeUndefined();
      })
  );

  it.effect(
    "a host that stops joining takes no fork, restore or clone of a source that requests the tailnet, and shows its build's copy excluded",
    () =>
      Effect.gen(function* () {
        const { tailnet } = minting();

        const { client, hosts, store, tailnetOf } = yield* served(
          joining(tailnet)
        );

        yield* client.create("dev", onTailnet("dev"));
        yield* tailnetOf();
        yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
        yield* client.buildTemplate({
          ...request("unused"),
          template: "web",
          tailnet: true,
          setup: { script: tailnetSetup, timeoutSeconds: 30 },
        });

        const [host] = hosts;

        if (host !== undefined) {
          yield* restartedHost(host, { tailnet: false });
        }

        const refused = yield* Effect.forEach(
          [
            client.forkMachine({ machine: "dev", name: "forked" }),
            client.restoreMachine({ checkpoint: "snap", name: "restored" }),
            client.create("clone", { template: "web" }),
          ],
          Effect.flip
        );

        const template = yield* client.getTemplate({ id: "web" });

        expect(refused.map(({ _tag }) => _tag)).toStrictEqual([
          "NotOffered",
          "NotOffered",
          "NotBuilt",
        ]);
        expect(refused[0]?.message).toContain(
          "joins no machine to the tailnet"
        );
        expect(template.builds[0]?.copies).toStrictEqual([
          {
            host: host?.id,
            phase: "excluded",
            reason: `${host?.id} joins no machine to the tailnet, and web@1 requests it`,
          },
        ]);
        expect((yield* store.machines).map(({ name }) => name)).toStrictEqual([
          "dev",
        ]);
      })
  );

  it.effect(
    "a machine that requests no tailnet shows none, on a host that joins",
    () =>
      Effect.gen(function* () {
        const { minted, tailnet } = minting();
        const { client, shown } = yield* served(joining(tailnet));

        yield* client.create("dev", request("dev"));

        yield* Effect.sleep(Duration.millis(300));

        expect((yield* shown()).tailnet).toBeUndefined();
        expect(minted).toStrictEqual([]);
      })
  );

  it.effect(
    "a create that requests the tailnet goes only to a host that joins, and one named that doesn't is refused before anything is recorded",
    () =>
      Effect.gen(function* () {
        const { tailnet } = minting();

        const { client, store } = yield* served({
          tailscaled: true,
          tailnet,
          hosts: [{ id: "plain" }, { id: "joins", options: { tailnet: true } }],
        });

        const placed = yield* client.create("dev", onTailnet("dev"));

        const refused = yield* Effect.flip(
          client.create("pinned", { ...onTailnet("pinned"), host: "plain" })
        );

        expect(placed.tailnet).toMatchObject({ state: "pending" });
        expect(
          Option.map(yield* store.findMachine("dev"), ({ host }) => host)
        ).toStrictEqual(Option.some("joins"));
        expect(refused._tag).toBe("NotOffered");
        expect(refused.message).toContain(
          "plain joins no machine to the tailnet"
        );
        expect(Option.isNone(yield* store.findMachine("pinned"))).toBe(true);
      })
  );

  it.effect(
    "a control plane with no tailnet refuses a request for one before anything is recorded",
    () =>
      Effect.gen(function* () {
        const { client, store } = yield* served({
          tailscaled: true,
          runtime: { tailnet: true },
        });

        const create = yield* Effect.flip(
          client.create("dev", onTailnet("dev"))
        );

        const build = yield* Effect.flip(
          client.buildTemplate({
            ...request("unused"),
            template: "web",
            tailnet: true,
            setup: { script: tailnetSetup, timeoutSeconds: 30 },
          })
        );

        expect([create._tag, build._tag]).toStrictEqual(["Invalid", "Invalid"]);
        expect(create.message).toContain("the control plane has no tailnet");
        expect(Option.isNone(yield* store.findMachine("dev"))).toBe(true);
        expect(Option.isNone(yield* store.findTemplate("web"))).toBe(true);
      })
  );

  it.effect("a stopped machine shows its tailnet pending", () =>
    Effect.gen(function* () {
      const { tailnet } = minting();
      const { client, tailnetOf } = yield* served(joining(tailnet));

      yield* client.create("dev", onTailnet("dev"));
      yield* tailnetOf();

      const stopped = yield* client.stopMachine({ id: "dev" });

      expect(stopped.tailnet).toStrictEqual({ state: "pending" });
    })
  );

  it.effect(
    "a machine stopped outside the control plane shows its tailnet pending",
    () =>
      Effect.gen(function* () {
        const { tailnet } = minting();

        const { client, hosts, shown, tailnetOf } = yield* served(
          joining(tailnet)
        );

        yield* client.create("dev", onTailnet("dev"));
        yield* tailnetOf();

        for (const held of hosts[0]?.fake.machines.values() ?? []) {
          held.state = "stopped";
        }

        const seen = yield* shown();

        expect([seen.state, seen.tailnet]).toStrictEqual([
          "stopped",
          { state: "pending" },
        ]);
      })
  );

  it.effect(
    "a stop asked while a machine's join waits for its key stops it at once, and mints no other key",
    () =>
      Effect.gen(function* () {
        const hold = yield* Deferred.make<undefined>();
        const entered = yield* Deferred.make<undefined>();
        const { begun, minted, tailnet } = minting({ hold, entered });

        const { client, asking, hosts, store } = yield* served(
          joining(tailnet)
        );

        yield* asking.create("dev", onTailnet("dev"));
        yield* Deferred.await(entered);
        yield* eventually(
          store.operationOn("machine", "dev"),
          (found) => found._tag === "Some" && found.value.kind === "join"
        );
        yield* asking.stopMachine({ id: "dev" });

        const stopped = yield* eventually(
          client.getMachine({ id: "dev" }),
          (machine) =>
            machine.state === "stopped" && machine.phase === "settled"
        );

        expect([
          stopped.desired,
          hosts[0]?.fake.machines.get("dev")?.state,
          begun.count,
          minted,
        ]).toStrictEqual(["stopped", "stopped", 1, []]);
      })
  );

  it.effect(
    "a machine asked to stop is stopped, not joined, when it runs again",
    () =>
      Effect.gen(function* () {
        const { minted, tailnet } = minting({ refuse: { count: 1 } });

        const { client, hosts } = yield* served(
          joining(tailnet, { recheck: Duration.millis(100) })
        );

        yield* client.create("dev", onTailnet("dev"));
        yield* client.stopMachine({ id: "dev" });

        const [host] = hosts;
        const before = minted.length;

        for (const held of host?.fake.machines.values() ?? []) {
          held.state = "running";
        }

        yield* eventually(
          Effect.sync(() => host?.fake.machines.get("dev")?.state),
          (state) => state === "stopped"
        );

        expect(minted).toHaveLength(before);
      })
  );

  it.effect(
    "a control plane that restarts checks a running machine again with no key, so it shows its tailnet",
    () =>
      Effect.gen(function* () {
        const { minted, tailnet } = minting();
        const planned = yield* plane(joining(tailnet));
        const first = yield* planned.start();
        const client = yield* clientOf(first.url);

        yield* client.create("dev", onTailnet("dev"));
        yield* eventually(
          client.getMachine({ id: "dev" }),
          (machine) => machine.tailnet?.state === "joined"
        );
        yield* first.crash;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);

        const again = yield* clientOf(second.url);

        expect(
          (yield* eventually(
            again.getMachine({ id: "dev" }),
            (machine) => machine.tailnet?.state === "joined"
          )).tailnet
        ).toStrictEqual(joinedName);
        expect(minted).toHaveLength(1);
      })
  );
});

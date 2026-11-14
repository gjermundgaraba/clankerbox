import { appendFileSync } from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import {
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Duration, Effect, FileSystem, Layer, Redacted } from "effect";
import { Hex } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import {
  checkTailnet,
  identify,
  prepare,
  prepareBase,
  runCommand,
  scrubNode,
} from "../../src/guest.ts";
import type { TailnetReport } from "../../src/guest.ts";
import * as Api from "../../src/platform/boat/api.ts";
import type {
  BoatType,
  ListedSnapshot,
  Sandbox,
  SshKey,
} from "../../src/platform/boat/api.ts";
import * as Boat from "../../src/platform/boat/boat.ts";
import { types } from "../../src/platform/boat/traits.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Target } from "../../src/runtime.ts";
import { runOfLabel } from "./marks.ts";
import {
  ledgerOf,
  listOnly,
  liveLedgers,
  namedOver,
  over,
  retired,
  retiredOver,
  sweepRead,
  thisHost,
} from "./sweep.ts";
import type { Found } from "./sweep.ts";

const key = process.env["BOAT_API_KEY"];

const live = process.env["CLANKERBOX_LIVE"] === "1" && key !== undefined;

const evidence = process.env["CLANKERBOX_LIVE_EVIDENCE"];

const api = process.env["BOAT_API"] ?? "https://boat.dev/api/v1";

const minted = (prefix: string) =>
  `${prefix}-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(6)))}`;

const host = minted("0live");

const suite = "boat";

const ledger = ledgerOf(liveLedgers, suite, host);

const note = (kind: "sandbox" | "snapshot", id: string) => {
  if (kind === "sandbox") {
    ledger.source(id);
  } else {
    ledger.copy(id);
  }
};

const liveInstance = () =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));

const finding = (text: string) =>
  Effect.sync(() => {
    const line = `${new Date().toISOString()} ${text}\n`;

    if (evidence === undefined) {
      process.stdout.write(line);
    } else {
      appendFileSync(path.join(evidence, "boat-live.txt"), line);
    }
  });

const ofTheRun = (sandbox: Sandbox) => sandbox.labels?.["cbx-host"] === host;

const runOf = (sandbox: Sandbox) => runOfLabel(sandbox.labels?.["cbx-host"]);

const labels = (instance: string) => ({
  "cbx-host": host,
  "cbx-instance": instance,
});

const running = new Set(["ready", "idle", "running"]);

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerNodeHttp
);

const client = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* scratch;
  const file = path.join(dir, "boat-key");

  yield* fs.writeFileString(file, key ?? "", { mode: 0o600 });

  return { api: yield* Api.make({ api, apiKeyFile: file }), dir };
});

const leftovers = (boat: Api.Api) =>
  sweepRead(
    ledger.ledgers,
    Effect.map(
      Effect.all([
        boat.sandboxes({}),
        boat.savedSnapshots("cbx-", () => false),
      ]),
      ([machines, copies]) => ({ machines, copies })
    ),
    {
      run: host,
      over: (each) => over(each, thisHost),
      named: namedOver,
      runOf,
      idOf: ({ id }) => id,
      keyOf: ({ name }) => name,
      sourceOf: ({ sourceSandboxId }) => sourceSandboxId,
    }
  );

const described = ({ machines, copies }: Found<Sandbox, ListedSnapshot>) =>
  [
    ...machines.map(
      ({ labels: marks }) =>
        `sandbox ${marks?.["cbx-host"] ?? ""}/${marks?.["cbx-instance"] ?? ""}`
    ),
    ...copies.map(({ name }) => `snapshot ${name}`),
  ].join(", ") || "nothing";

const emptied = (found: Found<Sandbox, ListedSnapshot>) =>
  found.machines.length === 0 && found.copies.length === 0;

const swept = (boat: Api.Api) =>
  Effect.gen(function* () {
    const before = yield* leftovers(boat);

    yield* finding(
      `the sweep selects ${described(before.swept)}${listOnly ? ", and deletes none of it, as CLANKERBOX_LIVE_LIST_ONLY asks" : ""}; it lists, of other live runs, ${described(before.listed)}`
    );

    if (listOnly) {
      return before;
    }

    for (let pass = 0; pass < 5; pass += 1) {
      const now = yield* leftovers(boat);

      if (emptied(now.swept)) {
        break;
      }

      yield* Effect.forEach(
        now.swept.copies,
        ({ name }) => Effect.ignore(boat.unsave(name)),
        { discard: true }
      );
      yield* Effect.forEach(
        now.swept.machines,
        ({ id }) => Effect.ignore(boat.remove(id)),
        { discard: true }
      );

      for (let tries = 0; tries < 240; tries += 1) {
        if ((yield* leftovers(boat)).swept.machines.length === 0) {
          break;
        }

        yield* Effect.sleep(Duration.millis(500));
      }
    }

    const after = yield* leftovers(boat);

    yield* Effect.sync(() => {
      retiredOver(liveLedgers, suite, after);
    });

    return after;
  });

const sshKeyOf = (dir: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const file = path.join(dir, "id_ed25519");

    yield* spawner.exitCode(
      ChildProcess.make("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "cbx-live",
        "-f",
        file,
      ])
    );

    return { file, publicKey: (yield* read(`${file}.pub`)).trim() };
  });

const backendOf = (report: TailnetReport | undefined) =>
  report?.state === "reported" ? report.backend : (report?.state ?? "none");

const family = (address: string | null | undefined) => {
  if (address === undefined || address === null) {
    return "none";
  }

  return address.includes(":") ? "IPv6" : "IPv4";
};

const sshAs = (
  dir: string,
  identity: string,
  answer: SshKey,
  command: string
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const knownHosts = path.join(dir, "known_hosts");
    const endpoint = Boat.endpointOf(answer);

    if (endpoint === undefined) {
      return yield* Effect.die(
        "boat answered an ssh endpoint with no host and port"
      );
    }

    const { host: address, port } = endpoint;

    yield* write(knownHosts, `live ${answer.hostKey}\n`);

    return yield* spawner.string(
      ChildProcess.make("ssh", [
        "-F",
        "/dev/null",
        "-i",
        identity,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
        "-o",
        "HostKeyAlias=live",
        "-p",
        String(port),
        "-l",
        "user",
        address,
        command,
      ])
    );
  });

describe.runIf(live)("boat, against the real account", () => {
  it.live(
    "answers as the planning probe found, and settles what it left open",
    () =>
      Effect.gen(function* () {
        const { api: boat, dir } = yield* client;
        const identity = yield* sshKeyOf(dir);
        const made: string[] = [];
        const saved: string[] = [];

        yield* finding(`host ${host}: the run's mark on every sandbox`);
        yield* swept(boat);

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const left = yield* swept(boat);

            yield* finding(
              `left at the end: ${left.swept.machines.length} sandboxes and ${left.swept.copies.length} saved snapshots of this run or one over, of ${made.length} sandboxes and ${saved.length} snapshots this test made`
            );
          }).pipe(Effect.orDie)
        );

        const startsUsed = Effect.map(
          boat.limits,
          (limits) => limits.starts?.hour?.used ?? -1
        );

        const until = (id: string, states: ReadonlySet<string>) =>
          Effect.gen(function* () {
            for (let tries = 0; tries < 600; tries += 1) {
              const sandbox = yield* boat.sandbox(id);

              if (sandbox !== undefined && states.has(sandbox.state)) {
                return sandbox;
              }

              yield* Effect.sleep(Duration.millis(500));
            }

            return yield* Effect.die(
              `${id} never reached ${[...states].join(", ")}`
            );
          });

        const limits = yield* boat.limits;

        const offered = (limits.machineTypes ?? []).flatMap(
          ({ type, available }) => (available ? [type] : [])
        );

        yield* finding(`GET /limits offers ${offered.join(", ")}`);
        expect(offered).toStrictEqual(
          expect.arrayContaining(["small", "default", "large"])
        );

        const a = minted("live");
        const before = yield* startsUsed;

        const first = yield* boat.create(
          { type: "small", labels: labels(a) },
          a
        );

        made.push(first.id);
        note("sandbox", first.id);

        const listed = yield* boat.sandboxes(labels(a));

        yield* until(first.id, running);

        const afterFirst = yield* startsUsed;

        const second = yield* boat.create(
          { type: "small", labels: labels(a) },
          a
        );

        const afterSecond = yield* startsUsed;

        yield* finding(
          `a create spent ${afterFirst - before} start, and the same create sent again under its Idempotency-Key answered ${second.id === first.id ? "the same sandbox" : second.id} and spent ${afterSecond - afterFirst}; the label list right after the create showed ${listed.map(({ state }) => state).join(", ")}`
        );
        expect(second.id).toBe(first.id);
        expect(listed.map(({ id }) => id)).toStrictEqual([first.id]);
        expect(afterFirst - before).toBe(1);
        expect(afterSecond - afterFirst).toBe(0);

        const once = yield* boat.sshKey(first.id, identity.publicKey);
        const twice = yield* boat.sshKey(first.id, identity.publicKey);

        yield* finding(
          `/sshkey answered machineIp ${family(once.machineIp)} and sshEndpoint ${once.sshEndpoint === undefined || once.sshEndpoint === null ? "none" : "set"}, and the same key and address when sent the key again`
        );
        expect(twice.hostKey).toBe(once.hostKey);
        expect(Boat.endpointOf(twice)).toStrictEqual(Boat.endpointOf(once));

        const ssh = (answer: SshKey, command: string) =>
          sshAs(dir, identity.file, answer, command);

        const lines = (yield* ssh(
          once,
          `grep -cxF -e '${identity.publicKey}' "$HOME/.ssh/authorized_keys"`
        )).trim();

        yield* finding(
          `a key sent to /sshkey twice is in authorized_keys ${lines} time(s)`
        );

        const disk = (answer: SshKey) =>
          Effect.map(
            ssh(
              answer,
              `lsblk -bdno SIZE "/dev/$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -n 1)" 2>/dev/null || lsblk -bdno SIZE "$(findmnt -no SOURCE /)"`
            ),
            (output) => Number(output.trim()) / 1024 ** 3
          );

        yield* finding(
          `small: the root's block device holds ${(yield* disk(once)).toFixed(2)} GiB`
        );

        const stopped = (id: string) =>
          Effect.andThen(boat.stop(id), until(id, new Set(["archived"])));

        const resumed = (id: string, type?: BoatType) =>
          Effect.gen(function* () {
            const starts = yield* startsUsed;

            const answer = yield* type === undefined
              ? boat.resume(id)
              : boat.retype(id, type);

            yield* until(id, running);

            return {
              answer,
              spent: (yield* startsUsed) - starts,
              key: yield* boat.sshKey(id, identity.publicKey),
            };
          });

        yield* stopped(first.id);

        const warm = yield* resumed(first.id);

        yield* finding(
          `a resume right after a stop answered ${warm.answer}, spent ${warm.spent} start, ${warm.key.hostKey === once.hostKey ? "the same" : "a new"} host key`
        );
        expect(warm.answer).toBe("kept");
        expect(warm.spent).toBe(0);
        expect(warm.key.hostKey).toBe(once.hostKey);

        for (const type of ["default", "large", "small"] as const) {
          yield* stopped(first.id);

          const resized = yield* resumed(first.id, type);

          yield* finding(
            `a resume onto ${type} answered ${resized.answer}, spent ${resized.spent} start, ${resized.key.hostKey === once.hostKey ? "the same" : "a new"} host key; the root's block device holds ${(yield* disk(resized.key)).toFixed(2)} GiB`
          );
          expect(resized.answer).toBe("started");
          expect(resized.spent).toBe(1);
        }

        yield* stopped(first.id);

        const snapshot = `cbx-${host}-snap`;

        saved.push(snapshot);
        note("snapshot", snapshot);
        yield* boat.save(first.id, snapshot);

        for (let tries = 0; tries < 240; tries += 1) {
          const state = yield* boat.saved(snapshot);

          if (state?.status !== "saving") {
            yield* finding(
              `a save of a stopped sandbox ended ${state?.status}, from ${state?.sourceSandboxId === first.id ? "its" : "another"} sandbox`
            );
            expect(state?.status).toBe("ready");
            expect(state?.sourceSandboxId).toBe(first.id);
            break;
          }

          yield* Effect.sleep(Duration.millis(500));
        }

        const b = minted("live");

        const restored = yield* boat.create(
          { type: "small", labels: labels(b), from: snapshot },
          b
        );

        made.push(restored.id);
        note("sandbox", restored.id);
        yield* until(restored.id, running);
        yield* boat.unsave(snapshot);

        const gone = yield* boat.saved(snapshot);

        yield* finding(
          `a restore from the snapshot ran; once deleted, the snapshot reads ${gone === undefined ? "404" : gone.status}`
        );
        expect(gone).toBeUndefined();

        yield* stopped(restored.id);

        const stoppedAt = Date.now();

        yield* boat.remove(first.id);
        yield* boat.remove(first.id);

        const deleted = yield* boat.sandbox(first.id);

        yield* finding(
          `a sandbox deleted twice then reads ${deleted === undefined ? "404" : deleted.state}`
        );
        expect(deleted).toBeUndefined();

        const restoredKey = yield* Effect.flatMap(
          boat.resume(restored.id),
          () => until(restored.id, running)
        ).pipe(
          Effect.andThen(boat.sshKey(restored.id, identity.publicKey)),
          Effect.tap(() => stopped(restored.id))
        );

        yield* Effect.sleep(
          Duration.millis(
            Math.max(0, 11 * 60 * 1000 - (Date.now() - stoppedAt))
          )
        );

        const cold = yield* resumed(restored.id);

        yield* finding(
          `a plain resume 11 minutes after a stop answered ${cold.answer}, spent ${cold.spent} start, ${cold.key.hostKey === restoredKey.hostKey ? "the same" : "a new"} host key and ${Boat.endpointOf(cold.key)?.host === Boat.endpointOf(restoredKey)?.host ? "the same" : "a new"} address`
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 40 * 60 * 1000 }
  );
  it.live(
    "makes, prepares, joins, restarts and forks a machine through the boat runtime",
    () =>
      Effect.gen(function* () {
        const { api: boat, dir } = yield* client;
        const identity = yield* sshKeyOf(dir);
        const tailnetKey = process.env["TAILSCALE_AUTHKEY"];

        yield* finding(`host ${host}: the runtime run's mark`);
        yield* swept(boat);

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const listed = yield* boat.sandboxes({ "cbx-host": host });
            const left = yield* swept(boat);

            yield* finding(
              `left at the end: ${left.swept.machines.length} sandboxes and ${left.swept.copies.length} saved snapshots of this run or one over; the run had ${listed.filter(ofTheRun).length} sandboxes labelled cbx-host=${host} when it ended`
            );
          }).pipe(Effect.orDie)
        );

        const context = yield* Layer.build(
          Boat.layer(
            { apiKeyFile: path.join(dir, "boat-key"), api },
            {
              id: host,
              stateDir: path.join(dir, "state"),
              listen: { address: "127.0.0.1", port: 1 },
            }
          )
        );

        const runtime = Context.get(context, Runtime);

        yield* finding(
          `the runtime's size classes: ${runtime.traits.sizes._tag === "classes" ? runtime.traits.sizes.classes.map(({ name }) => name).join(", ") : "free"}`
        );

        const providerKey = (machine: Target) =>
          Effect.map(
            boat.sshKey(machine.handle, identity.publicKey),
            ({ hostKey }) => hostKey.split(" ").slice(0, 2).join(" ")
          );

        const whoami = (machine: Target) =>
          Effect.map(
            runCommand(runtime, { machine, argv: ["whoami"], user: "admin" }),
            ({ output }) => output.trim()
          );

        const tailnet = (machine: Target, authKey?: string) =>
          checkTailnet(
            runtime,
            machine,
            minted("cbx-live"),
            authKey === undefined
              ? undefined
              : { key: Redacted.make(authKey), rejoin: false }
          );

        const source = { name: "ci", instance: liveInstance(), ...types.small };

        const made = yield* runtime.make(
          source,
          { _tag: "image", image: Boat.image },
          { _tag: "none" }
        );

        const ci: Target = { ...source, handle: made.handle };

        note("sandbox", made.handle);

        yield* prepareBase(runtime, ci, true);
        yield* identify(runtime, ci);

        const started = yield* prepare(runtime, ci);

        yield* finding(
          `after the base script and the identity script, the start script's host key ${started === (yield* providerKey(ci)) ? "equals" : "differs from"} the one /sshkey answers, and the guest runs commands as ${yield* whoami(ci)}`
        );
        expect(started).toBe(yield* providerKey(ci));
        expect(yield* whoami(ci)).toBe("admin");

        if (tailnetKey !== undefined) {
          const before = yield* tailnet(ci);
          const joined = yield* tailnet(ci, tailnetKey);

          yield* finding(
            `the tailnet script answered ${backendOf(before)} before the join and ${backendOf(joined)} after it`
          );
          expect(backendOf(joined)).toBe("Running");
        }

        yield* runtime.stop(ci);
        yield* runtime.start(ci, new Set());

        const warm = yield* prepare(runtime, ci);
        const warmTailnet = yield* tailnet(ci);

        yield* finding(
          `a stop then a start kept the host key: ${warm === started}; the tailnet answers ${backendOf(warmTailnet)}`
        );

        yield* runtime.stop(ci);

        const twin = { name: "twin", instance: liveInstance(), ...types.small };

        const forked = yield* runtime.make(
          twin,
          { _tag: "machine", machine: { ...ci, ...types.small } },
          { _tag: "none" }
        );

        const copy: Target = { ...twin, handle: forked.handle };

        note("sandbox", forked.handle);

        yield* identify(runtime, copy);

        const copyKey = yield* prepare(runtime, copy);
        const copyTailnet = yield* tailnet(copy);

        yield* finding(
          `the fork's start script key ${copyKey === (yield* providerKey(copy)) ? "equals" : "differs from"} /sshkey's, ${copyKey === started ? "the same as" : "unlike"} its source's; its tailnet answers ${backendOf(copyTailnet)} after the identity script`
        );
        expect(copyKey).toBe(yield* providerKey(copy));

        if (tailnetKey !== undefined) {
          expect(backendOf(copyTailnet)).toBe("NeedsLogin");
        }

        yield* runtime.resize(
          { ...ci, ...types.small },
          { cpu: types.default.cpu, ramMib: types.default.ramMib },
          false
        );

        const resized = yield* runtime.sizes(ci);

        yield* runtime.start(ci, new Set());

        const cold = yield* prepare(runtime, ci);
        const coldTailnet = yield* tailnet(ci);

        yield* finding(
          `a stopped resize to default reads ${resized.cpu} vCPUs and ${resized.ramMib} MiB; the start after it gave ${cold === started ? "the same" : "a new"} host key, which ${cold === (yield* providerKey(ci)) ? "equals" : "differs from"} /sshkey's, and the tailnet answers ${backendOf(coldTailnet)}`
        );
        expect(cold).toBe(yield* providerKey(ci));

        yield* scrubNode(runtime, ci);
        yield* runtime.stop(ci);

        const snapInstance = liveInstance();

        note("snapshot", `cbx-${snapInstance}`);

        const snapshot = yield* runtime.capture(ci, {
          name: "snap",
          instance: snapInstance,
        });

        yield* finding(`a capture of the stopped machine saved ${snapshot}`);

        yield* runtime.delete(ci, new Set());
        yield* runtime.delete(ci, new Set());
        yield* runtime.delete(copy, new Set());

        const gone = yield* runtime.find("machine", ci);

        const snapshotGone = yield* runtime.find("checkpoint", {
          name: "snap",
          instance: snapshot.slice("cbx-".length),
        });

        yield* finding(
          `after two deletes the machine is ${gone === undefined ? "gone" : "still found"}, and its unkept snapshot is ${snapshotGone === undefined ? "gone" : "still found"}`
        );
        expect(gone).toBeUndefined();
        expect(snapshotGone).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 30 * 60 * 1000 }
  );

  it.live(
    "leaves nothing of its run behind, and lists what other live runs hold",
    () =>
      Effect.gen(function* () {
        const { api: boat } = yield* client;
        const left = yield* swept(boat);

        yield* finding(
          `the final listing: of this run and any over, ${described(left.swept)}; of other live runs, ${described(left.listed)}`
        );
        expect(left.swept).toStrictEqual({ machines: [], copies: [] });
        yield* Effect.sync(() => {
          retired(liveLedgers, suite, host);
        });
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 5 * 60 * 1000 }
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Client,
  Conflict,
  Http,
  Internal,
  Invalid,
  NotFound,
  version,
  versionHeader,
  RuntimeName,
} from "@gjermundgaraba/clankerbox-sdk";
import type { MachineSpec } from "@gjermundgaraba/clankerbox-sdk";
import { mintToken, readCallers } from "@gjermundgaraba/clankerbox-sdk/node";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vite-plus/test";

import { minted } from "../../src/composition/tokens.ts";
import type { Store } from "../../src/store.ts";
import {
  copiesRunning,
  clientOf,
  eventually,
  plane,
  running,
  runtimes,
} from "../support.ts";

const spec: MachineSpec = {
  base: "ubuntu",
  runtime: RuntimeName.make("smolvm"),
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
};

const versioned = (sent: string) => ({ [versionHeader]: sent });

const bump = (part: 1 | 2) =>
  version
    .split(".")
    .map((value, index) => (index === part ? String(Number(value) + 1) : value))
    .join(".");

const post = (
  url: string,
  path: string,
  body: Schema.Json,
  headers: Record<string, string> = versioned(version)
) =>
  Effect.promise(async () => {
    const response = await fetch(`${url}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.text() };
  });

const createRaw = (url: string, id: string, headers?: Record<string, string>) =>
  post(url, "createMachine", { id, ...spec }, headers);

const decodeInvalid = Schema.decodeUnknownSync(Schema.fromJsonString(Invalid));

const decodeUnauthenticated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Action.Unauthenticated)
);

const bearing = (token: Redacted.Redacted) => ({
  ...versioned(version),
  authorization: `Bearer ${Redacted.value(token)}`,
});

const seeded = (
  store: Store["Service"],
  name: string,
  manages: boolean,
  mintedBy?: string
) =>
  Effect.gen(function* () {
    const { row, token } = yield* minted(name, manages, mintedBy);

    yield* store.insertToken(row);

    return token;
  });

const callersFile = (...lines: string[]) =>
  Effect.gen(function* () {
    const file = `${yield* scratch}/callers`;

    yield* write(file, `${lines.join("\n")}\n`);

    return file;
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the SDK's client drives a machine's lifecycle, a resize included, on a served control plane",
    () =>
      Effect.gen(function* () {
        const { url } = yield* running();
        const client = yield* clientOf(url);

        const hosts = yield* client.hosts;
        const made = yield* client.create("dev", spec);
        const stopped = yield* client.stopMachine({ id: "dev" });
        const resized = yield* client.resizeMachine({ id: "dev", cpu: 2 });
        const started = yield* client.startMachine({ id: "dev" });
        const listed = yield* client.listMachines();

        yield* client.deleteMachine({ id: "dev" });

        const gone = yield* Effect.flip(client.getMachine({ id: "dev" }));

        expect(hosts).toStrictEqual([
          {
            id: "smolvm",
            state: "up",
            runtime: "smolvm",
            version,
            runtimeVersion: "fake",
            bases: ["ubuntu"],
          },
        ]);
        expect(made).toMatchObject({ id: "dev", state: "running" });
        expect(stopped.state).toBe("stopped");
        expect([resized.cpu, resized.ramMib, resized.diskGib]).toStrictEqual([
          2, 1024, 10,
        ]);
        expect(started.state).toBe("running");
        expect(listed.map(({ id }) => id)).toStrictEqual(["dev"]);
        expect(gone._tag).toBe("NotFound");
      })
  );

  it.effect(
    "the hosts list says which host is up, draining or unreachable, and why",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          hosts: [{ id: "one" }, { id: "two" }, { id: "three" }],
          draining: ["two"],
        });

        yield* served.hosts[2]!.dispose;

        const client = yield* clientOf(served.url);
        const [up, draining, down] = yield* client.hosts;

        expect(up).toMatchObject({
          id: "one",
          state: "up",
          runtime: "smolvm",
        });
        expect(draining).toMatchObject({ id: "two", state: "draining" });
        expect(down).toMatchObject({
          id: "three",
          state: "unreachable",
          bases: [],
        });
        expect(down?.problem).toContain("three");
      })
  );

  it.effect(
    "the control plane sends each host its own token: a host that takes it is up and runs a create, one given another host's token is unreachable and says why, and one with no callers ignores it",
    () =>
      Effect.gen(function* () {
        const linux = mintToken("cp");
        const mac = mintToken("cp");

        const served = yield* running({
          hosts: [
            {
              id: "linux",
              options: {
                callers: yield* readCallers(yield* callersFile(linux.line)),
              },
              token: linux.token,
            },
            {
              id: "mac",
              options: {
                callers: yield* readCallers(yield* callersFile(mac.line)),
              },
              token: linux.token,
            },
            { id: "open", token: mac.token },
          ],
        });

        const client = yield* clientOf(served.url);
        const [up, refused, open] = yield* client.hosts;

        expect(up).toMatchObject({ id: "linux", state: "up" });
        expect(refused).toMatchObject({ id: "mac", state: "unreachable" });
        expect(refused?.problem).toContain(
          "host mac refused the control plane's token"
        );
        expect(open).toMatchObject({ id: "open", state: "up" });

        yield* client.create("dev", { ...spec, host: "linux" });

        const [machine] = yield* client.listMachines();

        expect(machine?.state).toBe("running");
        expect(
          served.hosts[0]!.fake.calls.filter((call) => call.includes("dev"))
        ).not.toStrictEqual([]);
      })
  );

  it.effect(
    "the control plane places an image reference on a linux host, and the machine boots from it",
    () =>
      Effect.gen(function* () {
        const served = yield* running();
        const client = yield* clientOf(served.url);
        const reference = "registry.example/team/orb:latest";
        const made = yield* client.create("orb", { ...spec, base: reference });

        expect(made).toMatchObject({ id: "orb", base: reference });
        expect(served.hosts[0]!.fake.images.get("orb")).toBe(reference);
      })
  );

  it.effect(
    "a refused restore or fork is about the resource that refused it, and names nothing made",
    () =>
      Effect.gen(function* () {
        const { url } = yield* running();
        const client = yield* clientOf(url);

        yield* client.create("source", spec);
        yield* client.create("taken", spec);

        const missing = yield* Effect.flip(
          client.restoreMachine({ checkpoint: "gone", name: "fresh" })
        );

        const taken = yield* Effect.flip(
          client.forkMachine({ machine: "source", name: "taken" })
        );

        expect(missing).toStrictEqual(
          new NotFound({
            message: "no checkpoint gone",
            action: "restoreMachine",
            id: "gone",
          })
        );
        expect(taken).toStrictEqual(
          new Conflict({
            message: "machine taken exists",
            action: "forkMachine",
            id: "taken",
          })
        );
      })
  );

  it.effect(
    "capacity counts each host's machines; a host whose runtime can't be read is named, and still placed on",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          runtime: { runtime: { ramBudgetMib: 4096 } },
        });

        const { fake } = served.hosts[0]!;
        const client = yield* clientOf(served.url);
        const before = yield* client.capacity;

        yield* client.create("dev", spec);

        const after = yield* client.capacity;

        fake.failNext(
          "capacity",
          new Internal({ message: "smolvm machine status didn't answer" })
        );

        const unread = yield* client.capacity;
        const hosts = yield* client.hosts;
        const placed = yield* client.create("other", spec);

        expect(before).toStrictEqual({
          usage: [
            { host: "smolvm", resource: "cpu", used: 0 },
            { host: "smolvm", resource: "ramMib", limit: 4096, used: 0 },
          ],
          unreported: [],
        });
        expect(after.usage).toStrictEqual([
          { host: "smolvm", resource: "cpu", used: 1 },
          { host: "smolvm", resource: "ramMib", limit: 4096, used: 1024 },
        ]);
        expect(unread).toStrictEqual({
          usage: [],
          unreported: [
            {
              host: "smolvm",
              state: "unreachable",
              problem: "smolvm machine status didn't answer",
            },
          ],
        });
        expect(hosts.map(({ id }) => id)).toStrictEqual(["smolvm"]);
        expect(placed.id).toBe("other");
      })
  );

  it.effect(
    "the SDK's client forks, captures, restores and deletes checkpoints on a served control plane",
    () =>
      Effect.gen(function* () {
        const { url, store } = yield* running(copiesRunning);
        const client = yield* clientOf(url);

        yield* client.create("dev", {
          ...spec,
          runtime: runtimes.copiesRunning,
        });

        const copy = yield* client.forkMachine({
          machine: "dev",
          name: "copy",
        });

        const captured = yield* client.captureCheckpoint({
          machine: "dev",
          name: "snap",
        });

        const listed = yield* client.listCheckpoints();
        const got = yield* client.getCheckpoint({ id: "snap" });

        const restored = yield* client.restoreMachine({
          checkpoint: "snap",
          name: "again",
        });

        const deleted = yield* client.deleteCheckpoint({ id: "snap" });
        const gone = yield* Effect.flip(client.getCheckpoint({ id: "snap" }));

        expect(copy).toMatchObject({
          id: "copy",
          state: "running",
          phase: "settled",
        });
        expect(captured).toMatchObject({
          id: "snap",
          machine: "dev",
          phase: "ready",
        });
        expect(listed).toStrictEqual([captured]);
        expect(got).toStrictEqual(captured);
        expect(restored).toMatchObject({
          id: "again",
          state: "running",
          phase: "settled",
        });
        expect(deleted).toBe("deleted");
        expect(gone._tag).toBe("NotFound");
        expect(yield* store.checkpoints).toStrictEqual([]);
      })
  );

  it.effect(
    "a raw create whose ID is too long, or smolvm's builders', is InvalidInput, and makes nothing",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();
        const calls = [...hosts[0]!.fake.calls];
        const tooLong = yield* createRaw(url, "a".repeat(64));
        const builders = yield* createRaw(url, "image-seed-x");

        expect(tooLong.status).toBe(400);
        expect(tooLong.body).toContain('"_tag":"InvalidInput"');
        expect(builders.status).toBe(400);
        expect(builders.body).toContain("smolvm takes for its own builders");
        expect(yield* store.machines).toStrictEqual([]);
        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect(
    "a raw capture or stop that names its checkpoint as a build's copy is InvalidInput, and captures nothing",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();
        const calls = [...hosts[0]!.fake.calls];

        const answers = [
          yield* post(url, "captureCheckpoint", {
            machine: "dev",
            name: "built-0123456789abcdef",
          }),
          yield* post(url, "stopMachine", {
            id: "dev",
            capture: { name: "fetched-0123456789abcdef" },
          }),
        ];

        for (const answer of answers) {
          expect(answer.status).toBe(400);
          expect(answer.body).toContain('"_tag":"InvalidInput"');
        }

        expect(yield* store.checkpoints).toStrictEqual([]);
        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect(
    "a raw exec whose argument, user or environment value holds a NUL byte is InvalidInput, and reaches no host",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();

        expect((yield* createRaw(url, "dev")).status).toBe(200);

        yield* eventually(
          store.machines,
          ([machine]) => machine?.state === "made.settled"
        );

        const calls = [...hosts[0]!.fake.calls];

        const answers = yield* Effect.forEach(
          [
            { id: "dev", argv: ["echo", "a\0b"] },
            { id: "dev", argv: ["true"], user: "ad\0min" },
            { id: "dev", argv: ["true"], env: { TOKEN: "sekret-value\0" } },
          ],
          (body) => post(url, "execMachine", body)
        );

        for (const answer of answers) {
          expect(answer.status).toBe(400);
          expect(answer.body).toContain('"_tag":"InvalidInput"');
          expect(answer.body).toContain("NUL");
          expect(answer.body).not.toContain("sekret-value");
        }

        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect(
    "a request of another release, or with no version, is Invalid and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();
        const calls = [...hosts[0]!.fake.calls];
        const older = versioned(bump(1));
        const created = yield* createRaw(url, "dev", older);
        const read = yield* post(url, "listHosts", {}, older);
        const unversioned = yield* createRaw(url, "dev", {});

        const malformed = yield* post(
          url,
          "createMachine",
          { id: "dev", labels: [] },
          older
        );

        for (const answer of [created, read, unversioned, malformed]) {
          expect(answer.status).toBe(400);
        }

        for (const answer of [created, read, malformed]) {
          expect(decodeInvalid(answer.body).message).toBe(
            `this control plane runs clankerbox ${version} and the caller is ${bump(1)}; their major.minor must match`
          );
        }

        expect(decodeInvalid(unversioned.body).message).toContain(
          `no ${versionHeader} header`
        );
        expect(decodeInvalid(unversioned.body).message).toContain(
          `clankerbox ${version}`
        );
        expect(yield* store.machines).toStrictEqual([]);
        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect(
    "every action refuses a request with no version, another release's, or one that carries Origin, as a browser's does, and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();

        expect((yield* createRaw(url, "dev")).status).toBe(200);

        const row = yield* eventually(
          store.machines,
          ([machine]) => machine?.state === "made.settled"
        );

        const calls = [...hosts[0]!.fake.calls];

        for (const { name } of Http.actions) {
          for (const [headers, says] of [
            [{}, /no clankerbox-version header/u],
            [versioned(bump(1)), /their major\.minor must match/u],
            [
              { ...versioned(version), origin: url },
              /takes no request that carries Origin/u,
            ],
          ] as const) {
            const answer = yield* post(url, name, { id: "dev" }, headers);

            expect(answer.status, name).toBe(400);
            expect(decodeInvalid(answer.body).message, name).toMatch(says);
          }
        }

        expect(yield* store.machines).toStrictEqual(row);
        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect(
    "a request of the control plane's release at another patch is served",
    () =>
      Effect.gen(function* () {
        const { url, store } = yield* running();
        const created = yield* createRaw(url, "dev", versioned(bump(2)));

        expect(created.status).toBe(200);
        expect((yield* store.machines).map(({ name }) => name)).toStrictEqual([
          "dev",
        ]);
      })
  );

  it.effect(
    "the SDK's client of another release reads the control plane's Invalid on every call kind",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();
        const calls = [...hosts[0]!.fake.calls];

        const older = FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
              const request = new Request(input, init);

              request.headers.set(versionHeader, bump(1));

              return await fetch(request);
            })
          )
        );

        const errors = yield* Effect.flatMap(Client.make(url), (client) =>
          Effect.all([
            Effect.flip(client.hosts),
            Effect.flip(client.listMachines()),
            Effect.flip(client.getMachine({ id: "dev" })),
            Effect.flip(client.create("dev", spec)),
          ])
        ).pipe(Effect.provide(older));

        for (const error of errors) {
          expect(error._tag).toBe("Invalid");
          expect(error.message).toContain(`the caller is ${bump(1)}`);
        }

        expect(yield* store.machines).toStrictEqual([]);
        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect(
    "the SDK's client builds, lists, reads and deletes a template over the routes",
    () =>
      Effect.gen(function* () {
        const { url } = yield* running();
        const client = yield* clientOf(url);

        const built = yield* client.buildTemplate({
          template: "web",
          ...spec,
          setup: { script: "#!/bin/sh\n" },
        });

        const listed = yield* client.templates;
        const read = yield* client.getTemplate({ id: "web" });
        const deleted = yield* client.deleteTemplate({ id: "web" });

        expect([built.id, built.phase]).toStrictEqual(["web@1", "ready"]);
        expect(listed.map(({ id, current }) => [id, current])).toStrictEqual([
          ["web", "web@1"],
        ]);
        expect(read).toMatchObject({
          state: "ready",
          builds: [{ id: "web@1", base: "ubuntu" }],
        });
        expect(deleted).toBe("deleted");
        expect(yield* client.templates).toStrictEqual([]);
      })
  );

  it.effect("a read of a template that doesn't exist is NotFound", () =>
    Effect.gen(function* () {
      const { url } = yield* running();

      const answer = yield* post(url, "getTemplate", { id: "nope" });

      expect(answer.status).toBe(404);
      expect(answer.body).toContain('"_tag":"NotFound"');
    })
  );

  it.effect(
    "a create whose client goes away still finishes and records its outcome",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running();
        const [host] = hosts;
        const { release, entered } = host!.fake.holdNext("create");
        const client = yield* clientOf(url);

        const sent = yield* Effect.forkChild(client.create("dev", spec));

        yield* entered;
        yield* Fiber.interrupt(sent);

        expect(Exit.hasInterrupts(yield* Fiber.await(sent))).toBe(true);

        yield* release;

        const [row] = yield* eventually(
          store.machines,
          ([machine]) => machine?.state === "made.settled"
        );

        expect(row?.state).toBe("made.settled");
        expect(host!.fake.calls).toContain("exec dev");
      })
  );
  it.effect(
    "with tokens, every action refuses a request with no token, a stranger's, or a Basic one, at 401 and runs nothing, and serves a token's caller",
    () =>
      Effect.gen(function* () {
        const { url, hosts, store } = yield* running({ tokens: true });
        const laptop = yield* seeded(store, "laptop", false);
        const stranger = mintToken("laptop").token;

        expect((yield* createRaw(url, "dev", bearing(laptop))).status).toBe(
          200
        );

        const row = yield* eventually(
          store.machines,
          ([machine]) => machine?.state === "made.settled"
        );

        const calls = [...hosts[0]!.fake.calls];

        for (const { name } of Http.actions) {
          for (const [headers, says] of [
            [versioned(version), /carries none/u],
            [bearing(stranger), /no caller with this token/u],
            [
              {
                ...versioned(version),
                authorization: `Basic ${Redacted.value(laptop)}`,
              },
              /carries none/u,
            ],
          ] as const) {
            const answer = yield* post(url, name, { id: "dev" }, headers);

            expect(answer.status, name).toBe(401);
            expect(decodeUnauthenticated(answer.body).message, name).toMatch(
              says
            );
          }
        }

        expect(yield* store.machines).toStrictEqual(row);
        expect(hosts[0]!.fake.calls).toStrictEqual(calls);
      })
  );

  it.effect("with tokens and none minted yet, every caller is refused", () =>
    Effect.gen(function* () {
      const { url } = yield* running({ tokens: true });

      expect(
        (yield* post(url, "listMachines", {}, bearing(mintToken("x").token)))
          .status
      ).toBe(401);
    })
  );

  it.effect(
    "the SDK's client sends its token, and one without a token or with another reads the refusal as Invalid, saying what to fix",
    () =>
      Effect.gen(function* () {
        const { url, store } = yield* running({ tokens: true });
        const laptop = yield* seeded(store, "laptop", false);

        const listed = yield* (yield* clientOf(url, {
          token: laptop,
        })).listMachines();

        expect(listed).toStrictEqual([]);

        for (const options of [{}, { token: mintToken("laptop").token }]) {
          const refused = yield* Effect.flip(
            (yield* clientOf(url, options)).listMachines()
          );

          expect(refused._tag).toBe("Invalid");
          expect(refused.message).toContain(
            "the control plane refused this caller: this control plane takes"
          );
          expect(refused.message).toContain("not revoked");
        }
      })
  );

  it.effect(
    "a revoked token is refused from its next request, with no restart, and still once the control plane restarts, while the rest are served",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane({ tokens: true });
        const seeding = yield* planned.start();
        const admin = yield* seeded(seeding.store, "admin", true);
        const orbs = yield* seeded(seeding.store, "orbs", false);

        yield* seeding.crash;

        const port = Number(new URL(seeding.url).port);
        const first = yield* planned.start(port);

        expect(
          (yield* post(first.url, "listMachines", {}, bearing(orbs))).status
        ).toBe(200);

        const revoked = yield* (yield* clientOf(first.url, {
          token: admin,
        })).revokeToken({ name: "orbs" });

        expect(revoked.revokedAt).toBeDefined();

        const refused = yield* post(
          first.url,
          "listMachines",
          {},
          bearing(orbs)
        );

        expect(refused.status).toBe(401);
        expect(decodeUnauthenticated(refused.body).message).toMatch(
          /no caller with this token/u
        );
        expect(
          (yield* post(first.url, "listMachines", {}, bearing(admin))).status
        ).toBe(200);

        yield* first.crash;

        const second = yield* planned.start(port);

        yield* Effect.addFinalizer(() => second.crash);

        expect(
          (yield* post(second.url, "listMachines", {}, bearing(orbs))).status
        ).toBe(401);
        expect(
          (yield* post(second.url, "listMachines", {}, bearing(admin))).status
        ).toBe(200);
      })
  );

  it.effect(
    "a token that manages tokens mints one that doesn't unless asked, taken from its next request, and list shows each with who minted it, a revoked minter's included",
    () =>
      Effect.gen(function* () {
        const { url, store } = yield* running({ tokens: true });
        const root = yield* seeded(store, "root", true);
        const rootClient = yield* clientOf(url, { token: root });

        const deputy = yield* rootClient.mintToken({
          name: "deputy",
          manages: true,
        });

        const deputyClient = yield* clientOf(url, {
          token: Redacted.make(deputy.token),
        });

        const laptop = yield* deputyClient.mintToken({ name: "laptop" });

        expect(
          (yield* post(
            url,
            "listMachines",
            {},
            bearing(Redacted.make(laptop.token))
          )).status
        ).toBe(200);

        yield* rootClient.revokeToken({ name: "deputy" });

        const listed = yield* rootClient.tokens;

        expect(
          listed.map(({ name, manages, mintedBy, revokedAt }) => [
            name,
            manages,
            mintedBy,
            revokedAt !== undefined,
          ])
        ).toStrictEqual([
          ["root", true, undefined, false],
          ["deputy", true, "root", true],
          ["laptop", false, "deputy", false],
        ]);
        expect(JSON.stringify(listed)).not.toContain(laptop.token);
        expect(
          (yield* Effect.flip(rootClient.mintToken({ name: "deputy" })))._tag
        ).toBe("Conflict");
        expect(
          (yield* Effect.flip(rootClient.revokeToken({ name: "nobody" })))._tag
        ).toBe("NotFound");
      })
  );

  it.effect(
    "a token that doesn't manage tokens, or a revoked one that did, can't list, mint or revoke them, and changes nothing",
    () =>
      Effect.gen(function* () {
        const { url, store } = yield* running({ tokens: true });
        const root = yield* seeded(store, "root", true);
        const laptop = yield* seeded(store, "laptop", false);
        const before = yield* store.tokens;

        for (const token of [laptop]) {
          const client = yield* clientOf(url, { token });

          for (const refused of [
            yield* Effect.flip(client.tokens),
            yield* Effect.flip(
              client.mintToken({ name: "more", manages: true })
            ),
            yield* Effect.flip(client.revokeToken({ name: "root" })),
          ]) {
            expect(refused._tag).toBe("Invalid");
            expect(refused.message).toContain("doesn't manage tokens");
          }
        }

        expect(yield* store.tokens).toStrictEqual(before);

        const rootClient = yield* clientOf(url, { token: root });

        yield* rootClient.revokeToken({ name: "root" });

        const after = yield* store.tokens;

        const revoked = yield* Effect.flip(
          rootClient.mintToken({ name: "more" })
        );

        expect(revoked._tag).toBe("Invalid");
        expect(revoked.message).toContain("refused this caller");
        expect(yield* store.tokens).toStrictEqual(after);
      })
  );

  it.effect(
    "without tokens, every caller is served as before, and the token actions say tokens are off",
    () =>
      Effect.gen(function* () {
        const { url } = yield* running();
        const client = yield* clientOf(url);

        expect(yield* client.listMachines()).toStrictEqual([]);

        const refused = yield* Effect.flip(client.mintToken({ name: "x" }));

        expect(refused._tag).toBe("Invalid");
        expect(refused.message).toContain("doesn't set tokens");
      })
  );
});

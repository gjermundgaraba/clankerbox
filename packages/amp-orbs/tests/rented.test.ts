import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { startRentedHost } from "@gjermundgaraba/clankerbox-host/testing/rented";
import type {
  RentedHost,
  RentedRuntime,
} from "@gjermundgaraba/clankerbox-host/testing/rented";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { clientOf, running } from "@gjermundgaraba/clankerbox-server/testing";
import { ConfigProvider, Effect, Layer, Runtime } from "effect";
import { CliOutput } from "effect/cli";
import { TestConsole } from "effect/testing";
import { expect } from "vite-plus/test";

import { orbLabel, snapshotLabel } from "../src/dispatch.ts";
import { run } from "../src/provider.ts";

const portsOn = {
  "smol-cloud": { first: 23_100, last: 23_109 },
  boat: { first: 23_110, last: 23_119 },
} as const;

const image = "registry.example/amp/orb:latest";

const orb = "amp-T-0199c2a3";

const other = "amp-T-0199c2a4";

const login = "root";

const spawnEnv = {
  ORB_OPERATION: "spawn",
  ORB_ID: orb,
  ORB_IMAGE: image,
  ORB_TOKEN: "orb-token",
  AMP_URL: "https://amp.test",
};

const stub = (bin: string, name: string, body: string) => {
  const file = path.join(bin, name);

  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

const imageTools = ["env", "sh", "cut", "mkdir", "setsid"];

const imageBinApartFromTheRunner = (dir: string, amp: boolean) => {
  const bin = path.join(dir, "image-bin");

  mkdirSync(bin);

  for (const tool of imageTools) {
    const found = ["/usr/bin", "/bin"]
      .map((folder) => path.join(folder, tool))
      .find((file) => existsSync(file));

    if (found === undefined) {
      throw new Error(`the runner has no ${tool} to link into the image`);
    }

    symlinkSync(found, path.join(bin, tool));
  }

  stub(bin, "id", 'echo "$CLANKERBOX_USER"');
  stub(
    bin,
    "getent",
    [
      'home="$CLANKERBOX_ROOT/home/$CLANKERBOX_USER"',
      'mkdir -p "$home"',
      'echo "$CLANKERBOX_USER:x:1000:1000::$home:/bin/sh"',
    ].join("\n")
  );
  stub(bin, "pkill", 'echo "$*" >>"$CLANKERBOX_ROOT/pkilled"');

  if (amp) {
    stub(
      bin,
      "amp",
      'printf "%s\\n" "$*" "user=$(id -un)" "ORB_TOKEN=$ORB_TOKEN" "AMP_URL=$AMP_URL" >"$HOME/amp-ran"'
    );
  }

  return bin;
};

const ran = (host: RentedHost) => {
  if (host.api.runtime !== "smol-cloud") {
    return [];
  }

  return [...host.api.fake.machines.values()].flatMap(({ root }) => {
    const file = path.join(root, "home", login, "amp-ran");

    return existsSync(file)
      ? [readFileSync(file, "utf8").trim().split("\n")]
      : [];
  });
};

const pkilled = (host: RentedHost) =>
  host.api.runtime === "smol-cloud"
    ? [...host.api.fake.machines.values()].flatMap(({ root }) => {
        const file = path.join(root, "pkilled");

        return existsSync(file)
          ? readFileSync(file, "utf8").trim().split("\n")
          : [];
      })
    : [];

const tokens = (host: RentedHost) =>
  ran(host)
    .flatMap((said) => said.filter((line) => line.startsWith("ORB_TOKEN=")))
    .toSorted((left, right) => left.localeCompare(right));

const eventually = <A>(read: () => A, expected: A) =>
  Effect.promise(async () => {
    await expect.poll(read, { timeout: 10_000 }).toStrictEqual(expected);
  });

const restoredFrom = (host: RentedHost) =>
  host.api.runtime === "smol-cloud"
    ? [...host.api.fake.machines.values()].filter(
        ({ restoredFrom: from }) => from !== undefined
      )
    : [];

const orbsOn = Effect.fn("orbsOn")(function* (
  runtime: RentedRuntime,
  { amp = true }: { readonly amp?: boolean } = {}
) {
  const dir = yield* scratch;

  const host = yield* startRentedHost(path.join(dir, "host"), {
    runtime,
    id: runtime,
    ports: portsOn[runtime],
    guestPath: imageBinApartFromTheRunner(dir, amp),
  });

  const plane = yield* running({
    hosts: [],
    members: [{ id: host.id, url: host.url, draining: false }],
  });

  const config = path.join(dir, "amp-orbs.json");

  yield* write(
    config,
    JSON.stringify({
      server: plane.url,
      sizes: { default: { cpu: 2, ramMib: 2048, diskGib: 10 } },
      user: login,
    })
  );

  const dispatched = (env: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(run(["--config", config]));
      const stdout = yield* TestConsole.logLines;
      const stderr = yield* TestConsole.errorLines;

      let code = -1;

      Runtime.defaultTeardown(exit, (exitCode) => {
        code = exitCode;
      });

      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(TestConsole.layer),
          CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
          NodeHttpClient.layerNodeHttp,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env } }))
        )
      )
    );

  return { host, client: yield* clientOf(plane.url), dispatched };
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the dispatch program spawns an orb on a smol cloud host, pauses it with a snapshot, resumes it, restores another from the snapshot and deletes both, as Amp's jobs ask",
    () =>
      Effect.gen(function* () {
        const { host, client, dispatched } = yield* orbsOn("smol-cloud");

        const spawned = yield* dispatched(spawnEnv);

        expect(spawned).toMatchObject({ code: 0, stderr: "" });
        expect(spawned.stdout).toContain(`machine ${orb} is running`);
        expect(pkilled(host)).toStrictEqual([
          `-u ${login} -f amp orb bootstra[p]`,
        ]);
        yield* eventually(
          () => ran(host),
          [
            [
              "orb bootstrap",
              `user=${login}`,
              "ORB_TOKEN=orb-token",
              "AMP_URL=https://amp.test",
            ],
          ]
        );

        const paused = yield* dispatched({
          ORB_OPERATION: "pause",
          ORB_ID: orb,
          ORB_SNAPSHOT_ID: "snap-1",
        });

        expect(paused).toMatchObject({ code: 0, stderr: "" });
        expect(yield* client.getMachine({ id: orb })).toMatchObject({
          state: "paused",
        });
        expect(yield* client.getCheckpoint({ id: "snap-1" })).toMatchObject({
          machine: orb,
          phase: "ready",
          labels: { [orbLabel]: orb, [snapshotLabel]: "snap-1" },
        });

        const resumed = yield* dispatched({
          ...spawnEnv,
          ORB_TOKEN: "resumed-token",
          ORB_SNAPSHOT_ID: "snap-1",
        });

        expect(resumed).toMatchObject({ code: 0, stderr: "" });
        expect(yield* client.getMachine({ id: orb })).toMatchObject({
          state: "running",
        });

        const restored = yield* dispatched({
          ...spawnEnv,
          ORB_ID: other,
          ORB_TOKEN: "restored-token",
          ORB_SNAPSHOT_ID: "snap-1",
        });

        expect(restored).toMatchObject({ code: 0, stderr: "" });
        expect(
          (yield* client.listMachines()).map(({ id, state }) => [id, state])
        ).toStrictEqual([
          [orb, "running"],
          [other, "running"],
        ]);
        expect(restoredFrom(host)).toHaveLength(1);
        yield* eventually(
          () => tokens(host),
          ["ORB_TOKEN=restored-token", "ORB_TOKEN=resumed-token"]
        );

        for (const id of [orb, other]) {
          const deleted = yield* dispatched({
            ORB_OPERATION: "delete",
            ORB_ID: id,
          });

          expect(deleted).toMatchObject({ code: 0, stderr: "" });
          expect(deleted.stdout).toContain(`machine ${id} deleted`);
        }

        expect(yield* client.listMachines()).toStrictEqual([]);
      }),
    60_000
  );

  it.effect(
    "a spawn into an image whose login user has no amp fails, saying so",
    () =>
      Effect.gen(function* () {
        const { dispatched } = yield* orbsOn("smol-cloud", { amp: false });

        const spawned = yield* dispatched(spawnEnv);

        expect(spawned.code).toBe(1);
        expect(spawned.stderr).toContain(
          `starting amp orb bootstrap in ${orb} exited 127: amp isn't on ${login}'s PATH`
        );
      }),
    60_000
  );

  it.effect(
    "a spawn on a boat host, which boots only its own named images, is refused before anything is made",
    () =>
      Effect.gen(function* () {
        const { client, dispatched } = yield* orbsOn("boat");

        const spawned = yield* dispatched(spawnEnv);

        expect(spawned.code).toBe(1);
        expect(spawned.stderr).toContain(`no host offers base ${image}`);
        expect(yield* client.listMachines()).toStrictEqual([]);
      })
  );
});

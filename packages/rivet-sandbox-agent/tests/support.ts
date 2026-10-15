import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type Checkpoint,
  Client,
  type Declared,
  type Machine,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import {
  machine,
  type StubHost,
  stubHost,
  transport,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { provider } from "../src/provider.ts";
import type { Options } from "../src/options.ts";

export const fakeSsh = fileURLToPath(new URL("fake-ssh.mjs", import.meta.url));

const url = "http://linux.test";

export const login = { user: "root", host: "100.64.0.7", port: 10_022 };

export const runtimeVersion = "0.0.0-test";

export const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux";

export const reachable = (id: string, fields?: Partial<Machine>) =>
  machine(id, { ssh: login, hostKey, ...fields });

export const cleanups: Array<() => Promise<void>> = [];

export const cleanUp = async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
};

interface Call {
  readonly pid: number;
  readonly port: number;
  readonly args: ReadonlyArray<string>;
}

export const setup = async (
  host: {
    readonly machines?: ReadonlyArray<Machine>;
    readonly checkpoints?: ReadonlyArray<Checkpoint>;
    readonly createFails?: Declared<"createMachine">;
    readonly createRefused?: Declared<"createMachine">;
  },
  options: Omit<Options, "hosts" | "from"> & { readonly from?: Options["from"] } = {},
  ssh = fakeSsh,
  wrap: (client: Client.Interface) => Client.Interface = (client) => client,
) => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-provider-"));

  const stub: StubHost = stubHost({
    id: "linux",
    bases: ["ubuntu"],
    machines: host.machines ?? [],
    checkpoints: host.checkpoints ?? [],
    runtimeVersion,
    create: ({ id }) => {
      if (host.createRefused !== undefined) {
        return Effect.fail(host.createRefused);
      }

      const made = reachable(id, { made: host.createFails === undefined });

      stub.hold(made);

      return host.createFails === undefined ? Effect.succeed(made) : Effect.fail(host.createFails);
    },
  });

  const profile = join(dir, "agent.json");

  await writeFile(profile, JSON.stringify({ base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20 }));
  process.env["FAKE_SSH_DIR"] = dir;

  const hosts = [{ id: "linux", url }];

  const sandbox = provider(
    { hosts, from: { profile }, ...options },
    Layer.mergeAll(
      Layer.effect(Client.Client, Effect.map(Client.make(hosts), wrap)).pipe(
        Layer.provide(transport(new Map([[new URL(url).origin, stub]]))),
      ),
      NodeServices.layer,
    ),
    ssh,
  );

  cleanups.push(async () => {
    await sandbox.dispose();
    await stub.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const calls = async (): Promise<Array<Call>> =>
    (await readFile(join(dir, "calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));

  return { dir, stub, sandbox, calls };
};

export const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => resolve(false));
  });

export const gone = (pid: number) => {
  try {
    process.kill(pid, 0);

    return false;
  } catch {
    return true;
  }
};

export const until = async (what: string, check: () => Promise<boolean>) => {
  const deadline = performance.now() + 5000;

  while (!(await check())) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

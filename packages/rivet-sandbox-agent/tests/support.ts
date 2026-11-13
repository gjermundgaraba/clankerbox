import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine } from "@gjermundgaraba/clankerbox-sdk";
import {
  machine,
  stubServer,
  transport,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type {
  MachineStep,
  StubServer,
  StubServerOptions,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect, Layer, Schema } from "effect";

import type { Options } from "../src/options.ts";
import { provider } from "../src/provider.ts";

export const fakeSsh = fileURLToPath(new URL("fake-ssh.ts", import.meta.url));

const url = "http://server.test";

export const login = { user: "admin", host: "100.64.0.7", port: 10_022 };

export const hostKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux";

export const reachable = (id: string, fields?: Partial<Machine>) =>
  machine(id, { ssh: login, hostKey, ...fields });

export const requests = (stub: StubServer) =>
  stub.calls.filter((call) => call !== "machine.get");

export const recording =
  (sent: unknown[]) =>
  (client: Client.Interface): Client.Interface => ({
    ...client,
    forkMachine: (input) =>
      Effect.andThen(
        Effect.sync(() => sent.push(input)),
        client.forkMachine(input)
      ),
    restoreMachine: (input) =>
      Effect.andThen(
        Effect.sync(() => sent.push(input)),
        client.restoreMachine(input)
      ),
    resizeMachine: (input) =>
      Effect.andThen(
        Effect.sync(() => sent.push(input)),
        client.resizeMachine(input)
      ),
  });

export const cleanups: Array<() => Promise<void>> = [];

export const cleanUp = async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
};

const Call = Schema.Struct({
  pid: Schema.Finite,
  port: Schema.Finite,
  args: Schema.Array(Schema.String),
});

type Call = typeof Call.Type;

const decodeCall = Schema.decodeSync(Schema.fromJsonString(Call));

export const setup = async (
  server: Pick<StubServerOptions, "machines" | "checkpoints" | "refuse"> & {
    readonly created?: readonly MachineStep[];
  } = {},
  options: Omit<Options, "server" | "from"> & {
    readonly from?: Options["from"];
  } = {},
  ssh = fakeSsh,
  wrap: (client: Client.Interface) => Client.Interface = (client) => client
) => {
  const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-provider-"));
  const { created = [], ...rows } = server;

  const stub: StubServer = stubServer({
    ...rows,
    create: ({ id }) =>
      Effect.sync(() => {
        const recorded = reachable(id, {
          state: "unknown",
          phase: "observing",
        });

        stub.hold(recorded);
        stub.script(id, created);

        return recorded;
      }),
  });

  process.env["FAKE_SSH_DIR"] = dir;

  const sandbox = provider(
    { server: url, from: { template: "agent" }, ...options },
    Layer.mergeAll(
      Layer.effect(Client.Client, Effect.map(Client.make(url), wrap)).pipe(
        Layer.provide(transport(new Map([[new URL(url).origin, stub]])))
      ),
      NodeServices.layer
    ),
    ssh
  );

  cleanups.push(async () => {
    await sandbox.dispose();
    await stub.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const calls = async (): Promise<Call[]> => {
    const recorded = await readFile(path.join(dir, "calls"), "utf-8").catch(
      () => ""
    );

    return recorded
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => decodeCall(line));
  };

  return { dir, stub, sandbox, calls };
};

export const listening = async (port: number) => {
  const reached = Promise.withResolvers<boolean>();
  const socket = connect({ host: "127.0.0.1", port });

  socket.once("connect", () => {
    socket.destroy();
    reached.resolve(true);
  });

  socket.once("error", () => {
    reached.resolve(false);
  });

  return await reached.promise;
};

/**
 * Ends this test program once the test that runs it lets go of its stdin, as its worker does when
 * it ends, without keeping the program running otherwise.
 */
export const endsWithParent = () => {
  process.stdin.once("end", () => process.exit(1));
  process.stdin.resume();

  if (process.stdin instanceof Socket) {
    process.stdin.unref();
  }
};

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

    await sleep(20);
  }
};

/** Waits for the stand-in agent in `dir` to hold a prompt. */
export const prompted = async (dir: string) => {
  await until(
    "the agent to hold a prompt",
    async () =>
      await access(path.join(dir, "prompted")).then(
        () => true,
        () => false
      )
  );
};

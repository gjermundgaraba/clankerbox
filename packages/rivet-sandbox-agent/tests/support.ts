import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, Socket } from "node:net";
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
  socket: Schema.String,
  args: Schema.Array(Schema.String),
});

type Call = typeof Call.Type;

const decodeCall = Schema.decodeSync(Schema.fromJsonString(Call));

/** The ssh calls fake-ssh recorded in `dir`, in the order they started. */
export const callsIn = async (dir: string): Promise<Call[]> => {
  const recorded = await readFile(path.join(dir, "calls"), "utf-8").catch(
    () => ""
  );

  return recorded
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decodeCall(line));
};

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

  let disposed = false;

  const dispose = async () => {
    if (!disposed) {
      disposed = true;
      await sandbox.dispose();
    }
  };

  cleanups.push(async () => {
    await dispose();
    await stub.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const calls = async () => await callsIn(dir);

  return { dir, stub, sandbox, calls, dispose };
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

/** The calls whose ssh still runs. */
export const live = <A extends { readonly pid: number }>(
  made: readonly A[]
): A[] => made.filter(({ pid }) => !gone(pid));

/** The one call whose ssh still runs, failing the test when there is none or more than one. */
export const liveTunnel = <A extends { readonly pid: number }>(
  made: readonly A[]
): A => {
  const running = live(made);
  const [tunnel] = running;

  if (tunnel === undefined || running.length > 1) {
    throw new Error(`expected one tunnel to run, and ${running.length} do`);
  }

  return tunnel;
};

/** The loopback port of a URL `getUrl` gave out. */
export const portOf = (given: string) => Number(new URL(given).port);

export const promptFor = (id: number) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "SECRET PROMPT" }] },
  }),
});

/**
 * Another program trying to listen on `port`, which answers everything as healthy: whether it
 * could, and each request it heard.
 */
export const stranger = async (port: number) => {
  const heard: string[] = [];

  const server = createHttpServer((request, reply) => {
    let body = "";

    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      heard.push(`${request.method} ${request.url} ${body}`);
      reply.end('{"status":"ok"}');
    });
  });

  const binding = Promise.withResolvers<string>();

  server.once("error", (error: NodeJS.ErrnoException) => {
    binding.resolve(error.code ?? error.message);
  });
  server.listen(port, "127.0.0.1", () => {
    binding.resolve("listening");
  });

  const bound = await binding.promise;

  cleanups.push(async () => {
    server.close();
  });

  return { bound, heard };
};

/** Whether another program could listen on `port` now, the probe of who holds it. */
export const free = async (port: number) => {
  const tried = Promise.withResolvers<boolean>();
  const server = createServer();

  server.once("error", () => {
    tried.resolve(false);
  });
  server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
    server.close(() => {
      tried.resolve(true);
    });
  });

  return await tried.promise;
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

/** A directory of the test's own, removed when it ends. */
export const scratch = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clankerbox-swept-"));

  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
};

/** Two minutes ago, past the age the sweep waits for. */
export const past = () => new Date(Date.now() - 120_000);

export const aged = async (made: string) => {
  await utimes(made, past(), past());
};

/** A directory as a tunnel leaves it, its known-hosts file in it, named `name` under `under`. */
export const leftIn = async (under: string, name: string) => {
  const made = path.join(under, name);

  await mkdir(made);
  await writeFile(path.join(made, "known_hosts"), "");

  return made;
};

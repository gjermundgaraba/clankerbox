import * as NodeServices from "@effect/platform-node/NodeServices";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { Effect, Layer, PlatformError, Predicate, Sink, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layer } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import { machine, scratch, stubHost, type StubHost } from "@gjermundgaraba/clankerbox-sdk/testing";
import { cleanup, cli, decodeJsonError, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly knownHosts: string;
  readonly knownHostsFile: string;
}

const fakeSsh = (code: number) => {
  const spawned: Array<Spawned> = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("ssh is a single command");
        }

        const option = command.args.find((arg) => arg.startsWith("UserKnownHostsFile="));
        const knownHostsFile = option?.slice("UserKnownHostsFile=".length) ?? "";

        spawned.push({
          command: command.command,
          args: command.args,
          knownHosts: readFileSync(knownHostsFile, "utf8"),
          knownHostsFile,
        });

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

  return { spawned, layer };
};

const reachable = machine("linux_dev", {
  ssh: { user: "user", host: "100.64.0.7", port: 10_022 },
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux_dev",
});

const setup = (held = reachable) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const config = yield* writeConfig(dir, ["linux"]);
    const linux = stubHost({ id: "linux", bases: ["ubuntu"], machines: [held] });

    stubs.push(linux);

    return { config, endpoints: [["linux", linux]] as const };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "ssh runs ssh pinned to the machine, as its user, with the caller's args, and removes the known-hosts file after",
    () =>
      Effect.gen(function* () {
        const { config, endpoints } = yield* setup();
        const ssh = fakeSsh(0);

        const { code } = yield* cli(
          ["ssh", "linux_dev", "--config", config, "--", "-L", "8080:localhost:80", "uptime"],
          { endpoints, spawner: ssh.layer },
        );

        const [spawned] = ssh.spawned;

        expect(code).toBe(0);
        expect(spawned?.command).toBe("ssh");
        expect(spawned?.knownHosts).toBe(
          "linux_dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n",
        );
        expect(spawned?.args.slice(0, 2)).toEqual(["-l", "user"]);
        expect(spawned?.args.slice(-4)).toEqual([
          "100.64.0.7",
          "-L",
          "8080:localhost:80",
          "uptime",
        ]);
        expect(existsSync(spawned?.knownHostsFile ?? "")).toBe(false);
      }),
  );

  it.effect("ssh USER@ID logs in to the machine as that user", () =>
    Effect.gen(function* () {
      const { config, endpoints } = yield* setup();
      const ssh = fakeSsh(0);

      const { code } = yield* cli(["ssh", "dev@linux_dev", "--config", config], {
        endpoints,
        spawner: ssh.layer,
      });

      expect(code).toBe(0);
      expect(ssh.spawned[0]?.args.slice(0, 2)).toEqual(["-l", "dev"]);
      expect(ssh.spawned[0]?.args.at(-1)).toBe("100.64.0.7");
    }),
  );

  it.effect(
    "ssh exits with ssh's exit code, through Exited's errorExitCode and the default teardown",
    () =>
      Effect.gen(function* () {
        const { config, endpoints } = yield* setup();

        const { code } = yield* cli(["ssh", "linux_dev", "--config", config], {
          endpoints,
          spawner: fakeSsh(255).layer,
        });

        expect(code).toBe(255);
      }),
  );

  it.effect("ssh into a machine that isn't a target fails with its reason and runs no ssh", () =>
    Effect.gen(function* () {
      const { config, endpoints } = yield* setup(machine("linux_dev", { state: "stopped" }));
      const ssh = fakeSsh(0);

      const { code, stderr } = yield* cli(["ssh", "linux_dev", "--config", config], {
        endpoints,
        spawner: ssh.layer,
      });

      expect(code).toBe(1);
      expect(stderr).toContain("clankerbox: WrongState: linux_dev has no SSH endpoint");
      expect(ssh.spawned).toEqual([]);
    }),
  );

  it.effect("ssh that can't be started is SpawnFailed, naming ssh", () =>
    Effect.gen(function* () {
      const { config, endpoints } = yield* setup();

      const missing = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.fail(
            PlatformError.badArgument({
              module: "ChildProcess",
              method: "spawn",
              description: "ssh: not found",
            }),
          ),
        ),
      );

      const { code, stdout } = yield* cli(["ssh", "linux_dev", "--json", "--config", config], {
        endpoints,
        spawner: missing,
      });

      expect(code).toBe(1);
      expect(decodeJsonError(stdout).error).toMatchObject({
        tag: "SpawnFailed",
        message: expect.stringContaining("couldn't run ssh"),
        retryable: false,
      });
    }),
  );

  it.effect("ssh-known-hosts prints the machine's host key under the name ssh asked for", () =>
    Effect.gen(function* () {
      const { config, endpoints } = yield* setup();

      const { code, stdout } = yield* cli(
        ["ssh-known-hosts", "--config", config, "linux_dev", "linux_dev"],
        { endpoints },
      );

      expect(code).toBe(0);
      expect(stdout).toBe("linux_dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample");
    }),
  );

  it.effect("ssh-proxy to a machine that isn't a target fails with its reason", () =>
    Effect.gen(function* () {
      const { config, endpoints } = yield* setup(machine("linux_dev", { state: "stopped" }));

      const { code, stderr } = yield* cli(["ssh-proxy", "--config", config, "linux_dev"], {
        endpoints,
      });

      expect(code).toBe(1);
      expect(stderr).toContain("clankerbox: WrongState: linux_dev has no SSH endpoint");
    }),
  );
});

const proxied = (serve: (socket: Socket) => void, stdin: Stream.Stream<Uint8Array>) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const listening = createServer(serve);

        listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
      }),
      (listening) =>
        Effect.callback<void>((resume) => {
          listening.close(() => resume(Effect.void));
        }),
    );

    const address = server.address();
    const port = address === null || Predicate.isString(address) ? 0 : address.port;
    const dir = yield* scratch;
    const config = yield* writeConfig(dir, ["linux"]);

    const linux = stubHost({
      id: "linux",
      bases: ["ubuntu"],
      machines: [
        machine("linux_dev", {
          ssh: { user: "user", host: "127.0.0.1", port },
          hostKey: "ssh-ed25519 AAAA",
        }),
      ],
    });

    stubs.push(linux);

    const received: Array<string> = [];

    const stdio = Stdio.layerTest({
      stdin,
      stdout: () => Sink.forEach((chunk) => Effect.sync(() => received.push(String(chunk)))),
    });

    const run = yield* cli(["ssh-proxy", "--config", config, "linux_dev"], {
      endpoints: [["linux", linux]],
      stdio,
    });

    return { ...run, received: received.join("") };
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "ssh-proxy carries stdin to the machine's endpoint and its replies to stdout, until it closes",
    () =>
      Effect.gen(function* () {
        const { code, stderr, received } = yield* proxied(
          (socket) => {
            socket.write("SSH-2.0-machine\r\n");
            socket.on("data", (data) => socket.write(`echo ${data.toString()}`));
            socket.on("end", () => socket.end());
          },
          Stream.make(new TextEncoder().encode("SSH-2.0-client")),
        );

        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(received).toBe("SSH-2.0-machine\r\necho SSH-2.0-client");
      }),
  );

  it.effect("ssh-proxy passes on the end of stdin even when it comes before the connection", () =>
    Effect.gen(function* () {
      const { code, received } = yield* proxied((socket) => {
        socket.on("data", () => undefined);
        socket.on("end", () => socket.end("bye"));
      }, Stream.empty);

      expect(code).toBe(0);
      expect(received).toBe("bye");
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { existsSync, readFileSync } from "node:fs";
import { Effect, Layer, PlatformError, Sink, Stream } from "effect";
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
  ssh: { user: "root", host: "100.64.0.7", port: 10_022 },
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
        expect(spawned?.args.slice(0, 2)).toEqual(["-l", "root"]);
        expect(spawned?.args.slice(-4)).toEqual(["linux_dev", "-L", "8080:localhost:80", "uptime"]);
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
      expect(ssh.spawned[0]?.args.at(-1)).toBe("linux_dev");
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
});

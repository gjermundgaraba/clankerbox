import { existsSync, readFileSync } from "node:fs";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterEach, expect, test } from "vite-plus/test";
import { machine, type StubHost, stubHost } from "../../../packages/contract/tests/stub-host.ts";
import { cleanup, cli, scratch, writeConfig } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly knownHosts: string;
  readonly knownHostsFile: string;
}

/**
 * A spawner standing in for the system ssh: it records the command, reads the known-hosts
 * file while ssh would be running, and exits with `code`.
 */
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
  ssh: { host: "100.64.0.7", port: 10_022 },
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux_dev",
});

const setup = async (held = reachable) => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = stubHost({ id: "linux", bases: ["ubuntu"], machines: [held] });

  stubs.push(linux);

  return { config, endpoints: [["linux", linux]] as const };
};

test("ssh pins the machine's host key in a one-line known-hosts file and passes the caller's args", async () => {
  const { config, endpoints } = await setup();
  const ssh = fakeSsh(0);

  const { code } = await cli(
    [
      "ssh",
      "linux_dev",
      "--config",
      config,
      "--",
      "-l",
      "root",
      "-L",
      "8080:localhost:80",
      "uptime",
    ],
    { endpoints, spawner: ssh.layer },
  );

  const [spawned] = ssh.spawned;

  expect(code).toBe(0);
  expect(spawned?.command).toBe("ssh");
  expect(spawned?.knownHosts).toBe("linux_dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n");
  expect(spawned?.args).toEqual([
    "-o",
    "HostName=100.64.0.7",
    "-o",
    "Port=10022",
    "-o",
    "HostKeyAlias=linux_dev",
    "-o",
    `UserKnownHostsFile=${spawned?.knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "linux_dev",
    "-l",
    "root",
    "-L",
    "8080:localhost:80",
    "uptime",
  ]);
  expect(existsSync(spawned?.knownHostsFile ?? "")).toBe(false);
});

test("ssh exits with ssh's exit code, through Exited's errorExitCode and the default teardown", async () => {
  const { config, endpoints } = await setup();

  const { code } = await cli(["ssh", "linux_dev", "--config", config], {
    endpoints,
    spawner: fakeSsh(255).layer,
  });

  expect(code).toBe(255);
});

test("ssh into a machine without an endpoint is Precondition and runs no ssh", async () => {
  const { config, endpoints } = await setup(machine("linux_dev", { state: "stopped" }));
  const ssh = fakeSsh(0);

  const { code, stderr } = await cli(["ssh", "linux_dev", "--config", config], {
    endpoints,
    spawner: ssh.layer,
  });

  expect(code).toBe(1);
  expect(stderr).toContain("Precondition");
  expect(ssh.spawned).toEqual([]);
});

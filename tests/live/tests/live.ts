/**
 * What the live tests drive: the clankerbox binary under test, against the hosts in a client
 * config, and a host-control program for what no client can do, such as killing the host.
 * Nothing here prints a setup script: tests write them to files the CLI reads.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoint, ErrorTag, Limit, Machine } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

export interface Ran {
  /** The exit code, or -1 when a signal ended the program. */
  readonly code: number;
  /** The signal that ended the program, if one did. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A program started with `launch`: its outcome, and a way to SIGKILL it before then. */
export interface Launched {
  readonly ran: Promise<Ran>;
  readonly kill: () => void;
}

/** Starts `file` with stdin closed. Its outcome never throws on a non-zero exit or a signal. */
export const launch = (file: string, args: ReadonlyArray<string>): Launched => {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Array<Buffer> = [];
  const stderr: Array<Buffer> = [];

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const ran = new Promise<Ran>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });

  return { ran, kill: () => child.kill("SIGKILL") };
};

/** Runs `file` to its end, with stdin closed, and never throws on a non-zero exit. */
export const run = (file: string, args: ReadonlyArray<string>): Promise<Ran> =>
  launch(file, args).ran;

const required = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the live tests`);
  }

  return value;
};

const HostEntry = Schema.Struct({ id: Schema.String, url: Schema.String });

const ClientConfig = Schema.fromJsonString(Schema.Struct({ hosts: Schema.Array(HostEntry) }));

const ErrorDocument = Schema.Struct({
  message: Schema.String,
  tag: ErrorTag,
  retryable: Schema.Boolean,
});

export const Failure = Schema.fromJsonString(Schema.Struct({ error: ErrorDocument }));

const Unreachable = Schema.Array(Schema.Struct({ host: Schema.String, error: ErrorDocument }));

export const Machines = Schema.fromJsonString(
  Schema.Struct({ machines: Schema.Array(Machine), unreachable: Unreachable }),
);

export const OneMachine = Schema.fromJsonString(Machine);

export const Checkpoints = Schema.fromJsonString(
  Schema.Struct({ checkpoints: Schema.Array(Checkpoint), unreachable: Unreachable }),
);

export const OneCheckpoint = Schema.fromJsonString(Checkpoint);

export const Limits = Schema.fromJsonString(
  Schema.Struct({ capacity: Schema.Array(Limit), unreachable: Unreachable }),
);

export const Names = Schema.fromJsonString(Schema.Array(Schema.String));

export const Store = Schema.fromJsonString(
  Schema.Struct({ checkpoints: Schema.Array(Schema.String) }),
);

export const Natives = Schema.fromJsonString(
  Schema.Struct({
    machines: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
    scopes: Schema.Array(Schema.String),
  }),
);

export const SmolvmStatus = Schema.fromJsonString(
  Schema.Struct({ state: Schema.String, pid: Schema.NullOr(Schema.Number) }),
);

export const TartNatives = Schema.fromJsonString(
  Schema.Struct({
    machines: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
    jobs: Schema.Array(Schema.String),
    files: Schema.Array(Schema.String),
  }),
);

export const Ports = Schema.fromJsonString(Schema.Array(Schema.Int));

export const BoatNatives = Schema.fromJsonString(
  Schema.Struct({
    sandboxes: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.String })),
  }),
);

export const BoatAccount = Schema.fromJsonString(
  Schema.Struct({ sandboxes: Schema.Number, snapshots: Schema.Number }),
);

/**
 * The live environment: `CLANKERBOX_BIN`, the binary under test; `CLANKERBOX_LIVE_CONFIG`, a
 * client config whose one host is the host under test; `CLANKERBOX_LIVE_HOST_CONTROL`, a
 * program run as `CONTROL OP ARGS…` on this machine that acts on the host under test; and
 * `CLANKERBOX_LIVE_PREFIX`, which every machine name of the run starts with. It carries the
 * run's ID, so the run's teardown finds, and only finds, what the run made.
 * `CLANKERBOX_LIVE_RUNTIME` names the host's runtime, and only that runtime's tests run.
 * `smolvm/driver.py`, `tart/driver.py` and `boat/driver.py` provide all five, and their teardown
 * removes what the run left on the host.
 *
 * A driver that runs a second host of the run, which only placement uses, names it in
 * `CLANKERBOX_LIVE_PLACEMENT_CONFIG`: a client config listing that host, beside the host under
 * test or alone (`tart/driver.py` does). The program's ops, on every runtime:
 *
 * - `host-stop`, `host-start`: stop the host process (SIGTERM), failing unless its exit status,
 *   as its unit or keeper records it, is 130, or start it;
 * - `host-kill`: SIGKILL the host process, as a crash, failing unless that is how it ended;
 * - `guest NAME COMMAND`: run COMMAND with `/bin/sh -c` as root in the guest of machine NAME,
 *   through the runtime (on boat, its command API), printing its output;
 * - `probe ADDRESS PORT`: from the host itself, print `reached` or `unreachable`.
 *
 * On smolvm:
 *
 * - `natives PREFIX`: print `{machines: [{name, state}], scopes}` for the runtime's machines and
 *   systemd scopes whose names start with PREFIX;
 * - `decoy NAME`: make and boot a native machine `NAME-<8 hex>` the host didn't make, and
 *   print its native name; `remove-native NATIVE` removes it;
 * - `freeze NAME`: freeze the guest's storage filesystem, so smolvm's stop can't quiesce it;
 * - `status NAME`: print `{state, pid}`, smolvm's own reading of machine NAME's state,
 *   `unreachable` included, and its VMM's pid;
 * - `stall NAME`: SIGSTOP machine NAME's VMM, wait until smolvm reads the machine unreachable,
 *   and print the VMM's pid;
 * - `forks`: print the names in the host's forks area; `plant-fork NAME` leaves a fork store
 *   named NAME there, as a crash during a fork would;
 * - `store`: print `{checkpoints}`, the names in the host's checkpoint store;
 * - `wait-host-exec NAME SECONDS`: wait until the host runs a guest command in machine NAME;
 * - `stop-host-at NAME SECONDS`: wait until the host moves the port of, or boots, the VM it
 *   made for machine NAME, hold that call, and stop the host (SIGTERM);
 * - `route ADDRESS`: print the host's `ip route get ADDRESS`.
 *
 * On Tart:
 *
 * - `natives NAME [HOST]`: print `{machines: [{name, state}], jobs, files}`, the VMs, launchd
 *   jobs and job files (plist and log) of machine or checkpoint NAME on the host under test, or
 *   on the run's second host when HOST names it;
 * - `addresses`: print the host's own IPv4 addresses, loopback aside;
 * - `listener`: print a TCP port that some process of the host listens on at every address;
 * - `host-ports`: print the TCP ports the host under test listens on, its API's and its
 *   forwarder's for every machine, whatever the machine's state.
 *
 * On boat, whose account may also hold the operator's own sandboxes and snapshots:
 *
 * - `natives NAME`: print `{sandboxes: [{id, state}]}`, the sandboxes whose display name is
 *   machine NAME's ID;
 * - `snapshots`: print the names of the run's named snapshots, which start `cbx-<host ID>-`;
 * - `account`: print `{sandboxes, snapshots}`, how many sandboxes and named snapshots the whole
 *   account holds, the operator's included.
 */
export const environment = async () => {
  const binary = required("CLANKERBOX_BIN");
  const config = required("CLANKERBOX_LIVE_CONFIG");
  const control = required("CLANKERBOX_LIVE_HOST_CONTROL");
  const prefix = required("CLANKERBOX_LIVE_PREFIX");
  const { hosts } = Schema.decodeUnknownSync(ClientConfig)(await readFile(config, "utf8"));
  const [host, ...others] = hosts;

  if (host === undefined || others.length > 0) {
    throw new Error("the live client config lists only the host under test");
  }

  return { binary, config, control, prefix, host, second: await secondHost(host) };
};

/** The second host `CLANKERBOX_LIVE_PLACEMENT_CONFIG` names, if the driver runs one. */
const secondHost = async (host: typeof HostEntry.Type) => {
  const file = process.env["CLANKERBOX_LIVE_PLACEMENT_CONFIG"];

  if (file === undefined || file === "") {
    return undefined;
  }

  const { hosts } = Schema.decodeUnknownSync(ClientConfig)(await readFile(file, "utf8"));
  const [second, ...others] = hosts.filter((entry) => entry.id !== host.id);

  if (second === undefined || others.length > 0) {
    throw new Error("the placement config lists one host besides the host under test");
  }

  return second;
};

export type Environment = Awaited<ReturnType<typeof environment>>;

/** A private scratch directory for keys, scripts and transfers. */
export const scratch = () => mkdtemp(join(tmpdir(), "clankerbox-live-"));

/** Writes `text` to `dir/name` with the given mode, and returns its path. */
export const writeFileIn = async (
  dir: string,
  name: string,
  text: string | Uint8Array,
  mode = 0o644,
) => {
  const file = join(dir, name);

  await writeFile(file, text, { mode });

  return file;
};

export const minutes = (count: number) => count * 60_000;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Prints a `[timing]` line, which the driver's evidence keeps. */
export const timing = (label: string, started: number) => {
  console.log(`[timing] ${label} ${((performance.now() - started) / 1000).toFixed(2)}s`);
};

/** Decodes a command's stdout, failing with its whole output. */
export const decode = <A>(schema: Schema.Codec<A, string>, ran: Ran): A => {
  try {
    return Schema.decodeUnknownSync(schema)(ran.stdout);
  } catch (error) {
    throw new Error(`couldn't decode (exit ${ran.code}): ${ran.stdout}\n${ran.stderr}`, {
      cause: error,
    });
  }
};

/** Whether this run is live on `runtime`, which `describe.skipIf` reads. */
export const liveOn = (runtime: "smolvm" | "tart" | "boat") =>
  process.env["CLANKERBOX_LIVE"] === "1" && process.env["CLANKERBOX_LIVE_RUNTIME"] === runtime;

/** Waits until `check` holds, checking every `everyMs`, and fails after `seconds`. */
export const waitFor = async (
  what: string,
  check: () => Promise<boolean>,
  seconds: number,
  everyMs = 500,
) => {
  const deadline = performance.now() + seconds * 1000;

  while (!(await check())) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
};

/** Runs the host-control program and decodes what it prints, failing the test on a non-zero exit. */
export type Controlled = <A>(
  schema: Schema.Codec<A, string>,
  ...args: ReadonlyArray<string>
) => Promise<A>;

/** What one runtime's suite tells the harness. */
export interface Runtime<Native> {
  /** A create's `--base` and sizes; with no arguments, those of a create with setup. */
  readonly sizes: (...args: ReadonlyArray<number>) => ReadonlyArray<string>;
  /** The native resources of the machine or checkpoint whose name on the host is `name`. */
  readonly natives: (controlled: Controlled, name: string) => Promise<Native>;
  /** What `natives` reads once a delete removed everything. */
  readonly nothing: Native;
  /** Writes the setup of `main`, for the run's public key, into `dir`, and returns its path. */
  readonly mainSetup: (dir: string, publicKey: string) => Promise<string>;
}

/**
 * Drives one runtime's host through the CLI. Before the suite's tests it reads the environment,
 * makes the run's scratch directory and key, and writes the setup of `main` there; after them it
 * removes that directory. `env`, `dir` and `mainSetup` are read once that has run.
 */
export const harness = <Native>(runtime: Runtime<Native>) => {
  let env: Environment;
  let dir: string;
  let key: string;
  let mainSetup: string;

  beforeAll(async () => {
    env = await environment();
    dir = await scratch();
    key = join(dir, "key");

    const keygen = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);

    expect(keygen.code, keygen.stderr).toBe(0);
    mainSetup = await runtime.mainSetup(dir, (await readFile(`${key}.pub`, "utf8")).trim());
  });

  // The driver's teardown removes what the run left on the host natively, so a test that leaves
  // the host down can't keep it there. This holds the run's private key and its setup scripts.
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Runs the CLI with the client config `config`. */
  const cliWith = (
    config: string,
    command: ReadonlyArray<string>,
    ...args: ReadonlyArray<string>
  ) => run(env.binary, [...command, "--config", config, ...args]);

  const cli = (command: ReadonlyArray<string>, ...args: ReadonlyArray<string>) =>
    cliWith(env.config, command, ...args);

  /** Starts the CLI, to SIGKILL it partway through its call. */
  const launchCli = (command: ReadonlyArray<string>, ...args: ReadonlyArray<string>) =>
    launch(env.binary, [...command, "--config", env.config, ...args]);

  /** A new resource's name, which carries the run's prefix like every other. */
  const named = (name: string) => `${env.prefix}${name}`;

  const id = (name: string) => `${env.host.id}_${named(name)}`;

  /** A create's name and `--host`, which send it to the run's host. */
  const target = (name: string) => [named(name), "--host", env.host.id];

  const control = (...args: ReadonlyArray<string>) => run(env.control, args);

  const controlled: Controlled = async (schema, ...args) => {
    const ran = await control(...args);

    expect(ran.code, ran.stderr).toBe(0);

    return decode(schema, ran);
  };

  const machines = async () => decode(Machines, await cli(["machines"], "--json"));

  const machine = async (name: string): Promise<Machine | undefined> =>
    (await machines()).machines.find((listed) => listed.id === id(name));

  /** The host's limits, which it answered for. */
  const capacity = async () => {
    const { capacity: limits, unreachable } = decode(Limits, await cli(["capacity"], "--json"));

    expect(unreachable).toEqual([]);

    return limits;
  };

  /** Creates `name` with no setup, at `sizes(...sizeArgs)`. */
  const createBare = (name: string, ...sizeArgs: ReadonlyArray<number>) =>
    cli(["create"], ...target(name), ...runtime.sizes(...sizeArgs), "--json");

  /** The arguments of a create of `name` with `script` as its setup file. */
  const createArgs = async (name: string, script: string, timeoutSeconds: number) => [
    ...target(name),
    ...runtime.sizes(),
    "--setup",
    await writeFileIn(dir, `${name}-setup.sh`, script, 0o755),
    "--setup-timeout",
    String(timeoutSeconds),
    "--json",
  ];

  /** Creates `name` with `script` as its setup file. */
  const createWith = async (name: string, script: string, timeoutSeconds: number) =>
    cli(["create"], ...(await createArgs(name, script, timeoutSeconds)));

  const ssh = (name: string, command: string) =>
    cli(
      ["ssh"],
      id(name),
      "--",
      "-i",
      key,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=30",
      command,
    );

  /** Runs `command` over ssh and returns its output, failing the test on a non-zero exit. */
  const inGuest = async (name: string, command: string) => {
    const ran = await ssh(name, command);

    expect(ran.code, `${command}: ${ran.stderr}`).toBe(0);

    return ran.stdout;
  };

  /**
   * What a machine shows of its identity, and of what a copy carried over: its machine ID and
   * instance, `~/live-disk`, and the lines `main`'s setup and hooks wrote to
   * `/var/lib/clankerbox-live/identities`, `starts` and `setups`.
   */
  const facts = async (name: string) => {
    const [machineId, instance, disk, identities, starts, setups] = (
      await inGuest(
        name,
        [
          "cat /var/lib/clankerbox/machine-id /var/lib/clankerbox/instance",
          "cat ~/live-disk 2>/dev/null || echo none",
          "wc -l </var/lib/clankerbox-live/identities",
          "wc -l </var/lib/clankerbox-live/starts",
          "wc -l </var/lib/clankerbox-live/setups",
        ].join("; "),
      )
    ).split("\n");

    return {
      machineId,
      instance,
      disk,
      identities: Number(identities),
      starts: Number(starts),
      setups: Number(setups),
    };
  };

  /** ssh options pinning `hostKey` under the machine's ID, as `clankerbox ssh` does. */
  const pinned = async (target: Machine, hostKey = target.hostKey ?? "") => {
    const knownHosts = await writeFileIn(
      dir,
      `known-hosts-${randomBytes(4).toString("hex")}`,
      `${target.id} ${hostKey}\n`,
    );

    return [
      "-o",
      `HostKeyAlias=${target.id}`,
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=30",
      "-i",
      key,
    ];
  };

  const failure = (ran: Ran) => {
    expect(ran.code, ran.stdout).toBe(1);

    return decode(Failure, ran).error;
  };

  const natives = (name: string) => runtime.natives(controlled, named(name));

  /** Whether the host itself reaches `address:port`. */
  const probe = async (address: string, port: string) => {
    const ran = await control("probe", address, port);

    expect(ran.code, ran.stderr).toBe(0);

    return ran.stdout;
  };

  /** Deletes the machine, then checks that its native resources are gone. */
  const removeMachine = async (name: string) => {
    const ran = await cli(["delete"], id(name), "--json");

    expect(ran.code, ran.stdout).toBe(0);
    expect(await natives(name)).toEqual(runtime.nothing);
  };

  return {
    get env() {
      return env;
    },
    get dir() {
      return dir;
    },
    get mainSetup() {
      return mainSetup;
    },
    cli,
    cliWith,
    launchCli,
    named,
    id,
    target,
    control,
    controlled,
    machines,
    machine,
    capacity,
    createBare,
    createArgs,
    createWith,
    ssh,
    inGuest,
    facts,
    pinned,
    failure,
    natives,
    probe,
    removeMachine,
  };
};

export type Harness<Native> = ReturnType<typeof harness<Native>>;

/** `args` with the value of its `--base` replaced by `base`. */
export const rebased = (args: ReadonlyArray<string>, base: string) =>
  args.map((arg, index) => (args[index - 1] === "--base" ? base : arg));

/**
 * Registers the test of what is refused before any runtime call, so it costs nothing native,
 * and on boat no start: a create under a taken name, which the host refuses, and a create by name
 * of a base no host offers, which placement refuses once it has read every host's bases. `taken`
 * names a machine the suite holds when the test runs.
 */
export const refusedBeforeTheRuntime = <Native>(
  suite: Harness<Native>,
  runtime: Runtime<Native>,
  taken: string,
) =>
  test(
    "a taken name is Conflict{exists}, and a base no host offers is Precondition naming the host's bases; neither writes anything",
    async () => {
      const before = await suite.machines();
      const exists = suite.failure(await suite.createBare(taken));

      expect(exists).toMatchObject({ tag: "Conflict", retryable: false });
      expect(exists.message).toContain("exists");

      // A name, not a full ID, so the client places it.
      const nowhere = suite.failure(
        await suite.cli(
          ["create"],
          suite.named("nowhere"),
          ...rebased(runtime.sizes(), "nowhere"),
          "--json",
        ),
      );

      expect(nowhere.tag).toBe("Precondition");
      expect(nowhere.message).toContain("no host offers base nowhere");
      expect(nowhere.message).toContain(`${suite.env.host.id} offers`);
      expect(await suite.machines()).toEqual(before);
      expect(await suite.natives("nowhere")).toEqual(runtime.nothing);
    },
    minutes(3),
  );

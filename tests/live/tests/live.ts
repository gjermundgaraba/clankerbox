/**
 * What the live tests drive: the clankerbox binary under test, against the hosts in a client
 * config, and a host-control program for what no client can do, such as killing the host.
 * Nothing here prints a setup script: tests write them to files the CLI reads.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoint, ErrorTag, Machine } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `file` to its end, with stdin closed, and never throws on a non-zero exit. */
export const run = (file: string, args: ReadonlyArray<string>): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });

const required = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the live tests`);
  }

  return value;
};

const ClientConfig = Schema.fromJsonString(
  Schema.Struct({ hosts: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })) }),
);

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

export const TartNatives = Schema.fromJsonString(
  Schema.Struct({
    machines: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
    jobs: Schema.Array(Schema.String),
    files: Schema.Array(Schema.String),
  }),
);

/**
 * The live environment: `CLANKERBOX_BIN`, the binary under test; `CLANKERBOX_LIVE_CONFIG`, a
 * client config whose one host is the host under test; `CLANKERBOX_LIVE_HOST_CONTROL`, a
 * program run as `CONTROL OP ARGS…` on this machine that acts on the host under test; and
 * `CLANKERBOX_LIVE_PREFIX`, which every machine name of the run starts with. It carries the
 * run's ID, so the run's teardown finds, and only finds, what the run made (rewrite.md, "Test
 * machine footprint"). `CLANKERBOX_LIVE_RUNTIME` names the host's runtime, and only that
 * runtime's tests run. `smolvm/driver.py` and `tart/driver.py` provide all five, and their
 * teardown removes what the run left on the host. The program's ops, on both runtimes:
 *
 * - `host-stop`, `host-start`: stop the host process (SIGTERM), failing unless its exit status,
 *   as its unit or keeper records it, is 0, or start it;
 * - `host-kill`: SIGKILL the host process, as a crash, failing unless that is how it ended;
 * - `guest NAME COMMAND`: run COMMAND with `/bin/sh -c` as root in the guest of machine NAME,
 *   through the runtime, printing its output;
 * - `probe ADDRESS PORT`: from the host itself, print `reached` or `unreachable`.
 *
 * On smolvm:
 *
 * - `natives PREFIX`: print `{machines: [{name, state}], scopes}` for the runtime's machines and
 *   systemd scopes whose names start with PREFIX;
 * - `decoy NAME`: make and boot a native machine `NAME-<8 hex>` the host didn't make, and
 *   print its native name; `remove-native NATIVE` removes it;
 * - `freeze NAME`: freeze the guest's storage filesystem, so smolvm's stop can't quiesce it;
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
 * - `natives NAME`: print `{machines: [{name, state}], jobs, files}`, the VMs, launchd jobs and
 *   job files (plist and log) of machine or checkpoint NAME;
 * - `addresses`: print the host's own IPv4 addresses, loopback aside;
 * - `listener`: print a TCP port that some process of the host listens on at every address.
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

  return { binary, config, control, prefix, host };
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

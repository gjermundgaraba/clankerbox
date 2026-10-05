/**
 * Live acceptance on a Tart host, through the CLI: lifecycle, setup and preparation on macOS
 * guests, the forwarder, Softnet, disk checkpoints and forks, Apple's two-VM limit, a host
 * restart and a crash. Apple runs at most two macOS VMs per Mac, so at most two of the run's VMs
 * run at once. The tests run in order and share `main`, whose setup sets public resolvers,
 * installs the run's key for `admin`, and writes a `start` and a `new-identity` hook; the test
 * that made any other machine deletes it. Timings print as `[timing]` lines.
 */
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { Machine, SshEndpoint } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  Checkpoints,
  decode,
  type Environment,
  environment,
  Failure,
  Machines,
  minutes,
  Names,
  OneCheckpoint,
  OneMachine,
  type Ran,
  run,
  scratch,
  sha256,
  TartNatives,
  timing,
  writeFileIn,
} from "./live.ts";

const live =
  process.env["CLANKERBOX_LIVE"] === "1" && process.env["CLANKERBOX_LIVE_RUNTIME"] === "tart";

/**
 * The setup of `main`. Softnet's block of the host also blocks the gateway's DNS, so public
 * resolvers come first (rewrite.md, Runtimes: Tart). `admin` is the Cirrus image's user. Setup
 * runs before preparation, so it records the image's host key, which preparation replaces.
 */
const mainSetup = (publicKey: string) => `#!/bin/sh
set -eu
networksetup -listallnetworkservices | tail -n +2 | sed 's/^\\*//' | while IFS= read -r service; do
  networksetup -setdnsservers "$service" 1.1.1.1 9.9.9.9
done
install -d -m 700 -o admin -g staff /Users/admin/.ssh
printf '%s\\n' '${publicKey}' >/Users/admin/.ssh/authorized_keys
chown admin:staff /Users/admin/.ssh/authorized_keys
chmod 600 /Users/admin/.ssh/authorized_keys
mkdir -p /etc/clankerbox /var/lib/clankerbox-live
cat >/etc/clankerbox/start <<'START'
#!/bin/sh
echo start >>/var/lib/clankerbox-live/starts
START
cat >/etc/clankerbox/new-identity <<'IDENTITY'
#!/bin/sh
echo identity >>/var/lib/clankerbox-live/identities
IDENTITY
chmod 755 /etc/clankerbox/start /etc/clankerbox/new-identity
cut -d ' ' -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub >/var/lib/clankerbox-live/setup-hostkey
echo setup >>/var/lib/clankerbox-live/setups
`;

/** A guest command that prints whether a TCP connection to `address:port` opens. */
const guestProbe = (address: string, port: string) =>
  `nc -z -G 5 -w 5 ${address} ${port} >/dev/null 2>&1 && echo reached || echo refused`;

/** What a client meets at an endpoint: sshd's banner, a connection closed at once, or a refusal. */
type Answer = "banner" | "closed" | "refused" | "silent";

const answer = (endpoint: SshEndpoint) =>
  new Promise<Answer>((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });

    const done = (result: Answer) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(30_000, () => done("silent"));
    socket.once("data", () => done("banner"));
    socket.once("end", () => done("closed"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        done("refused");
      } else if (error.code === "ECONNRESET") {
        done("closed");
      } else {
        reject(error);
      }
    });
  });

const nothing = { machines: [], jobs: [], files: [] };

describe.skipIf(!live)("a Tart host, through the CLI", () => {
  let env: Environment;
  let dir: string;
  let key: string;
  let setup: string;
  /** `main`'s endpoint, which a list reports only while it runs. */
  let mainEndpoint: SshEndpoint;

  const cli = (command: ReadonlyArray<string>, ...args: ReadonlyArray<string>) =>
    run(env.binary, [...command, "--config", env.config, ...args]);

  /** A new resource's name, which carries the run's prefix like every other. */
  const named = (name: string) => `${env.prefix}${name}`;

  const id = (name: string) => `${env.host.id}_${named(name)}`;

  const control = (...args: ReadonlyArray<string>) => run(env.control, args);

  const machines = async () => decode(Machines, await cli(["machines"], "--json"));

  const machine = async (name: string): Promise<Machine | undefined> =>
    (await machines()).machines.find((listed) => listed.id === id(name));

  /** The base's disk is 50 GB, and Tart only grows a disk (rewrite.md, Runtimes: Tart). */
  const sizes = (diskGib = 50) => [
    "--base",
    "macos",
    "--cpu",
    "2",
    "--ram-mib",
    "4096",
    "--disk-gib",
    String(diskGib),
  ];

  const createBare = (name: string, diskGib?: number) =>
    cli(["create"], id(name), ...sizes(diskGib), "--json");

  const createWith = async (name: string, script: string, timeoutSeconds: number) => {
    const file = await writeFileIn(dir, `${name}-setup.sh`, script, 0o755);

    return cli(
      ["create"],
      id(name),
      ...sizes(),
      "--setup",
      file,
      "--setup-timeout",
      String(timeoutSeconds),
      "--json",
    );
  };

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
      "-l",
      "admin",
      command,
    );

  /** Runs `command` over ssh and returns its output, failing the test on a non-zero exit. */
  const inGuest = async (name: string, command: string) => {
    const ran = await ssh(name, command);

    expect(ran.code, `${command}: ${ran.stderr}`).toBe(0);

    return ran.stdout;
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

  const controlled = async <A>(schema: Schema.Codec<A, string>, ...args: ReadonlyArray<string>) => {
    const ran = await control(...args);

    expect(ran.code, ran.stderr).toBe(0);

    return decode(schema, ran);
  };

  /** The VMs, launchd jobs and job files of machine or checkpoint `name`. */
  const natives = (name: string) => controlled(TartNatives, "natives", named(name));

  /** Whether the host itself reaches `address:port`. */
  const probe = async (address: string, port: string) => {
    const ran = await control("probe", address, port);

    expect(ran.code, ran.stderr).toBe(0);

    return ran.stdout;
  };

  /**
   * Deletes the machine, then checks that its VM, job, job files and listener are gone. A
   * stopped machine's endpoint isn't reported, so the caller can name it.
   */
  const removeMachine = async (name: string, known?: SshEndpoint) => {
    const endpoint = known ?? (await machine(name))?.ssh;
    const ran = await cli(["delete"], id(name), "--json");

    expect(ran.code, ran.stdout).toBe(0);
    expect(await natives(name)).toEqual(nothing);

    if (endpoint !== undefined) {
      expect(await answer(endpoint)).toBe("refused");
    }
  };

  const waitFor = async (what: string, check: () => Promise<boolean>, seconds: number) => {
    const deadline = performance.now() + seconds * 1000;

    while (!(await check())) {
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };

  /** What a machine shows of its identity, and of what a copy carried over. */
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

  /** When the guest booted; a VM that kept running keeps it. */
  const bootTime = (name: string) => inGuest(name, "sysctl -n kern.boottime");

  beforeAll(async () => {
    env = await environment();
    dir = await scratch();
    key = join(dir, "key");

    const keygen = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);

    expect(keygen.code, keygen.stderr).toBe(0);
    setup = await writeFileIn(
      dir,
      "main-setup.sh",
      mainSetup((await readFile(`${key}.pub`, "utf8")).trim()),
      0o755,
    );
  });

  // The driver's teardown removes what the run left on the host natively, so a test that leaves
  // the host down can't keep it there. This holds the run's private key and its setup scripts.
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test(
    "create runs setup once and then preparation, and reports the forwarder's endpoint and a fresh host key",
    async () => {
      const started = performance.now();

      const ran = await cli(
        ["create"],
        id("main"),
        ...sizes(),
        "--setup",
        setup,
        "--setup-timeout",
        "600",
        "--json",
      );

      timing("create with setup", started);
      expect(ran.code, ran.stdout).toBe(0);

      const made = decode(OneMachine, ran);

      expect(made).toMatchObject({
        id: id("main"),
        state: "running",
        action: { name: "create", status: "done" },
        ssh: { host: new URL(env.host.url).hostname },
      });
      expect(made.ssh?.port).toBeGreaterThanOrEqual(10_000);
      expect(made.ssh?.port).toBeLessThanOrEqual(19_999);
      expect(made.hostKey).toMatch(/^ssh-ed25519 /u);

      if (made.ssh === undefined) {
        throw new Error("main has no endpoint");
      }

      mainEndpoint = made.ssh;

      // clankerbox ssh pins Machine.hostKey, so logging in proves sshd serves the re-minted key.
      expect(await facts("main")).toEqual({
        machineId: id("main"),
        instance: expect.stringMatching(/^[0-9a-f]{32}$/u),
        disk: "none",
        identities: 1,
        starts: 1,
        setups: 1,
      });
      expect(await inGuest("main", "ls -A /var/tmp | grep -c clankerbox-setup || true")).toBe("0");
      // Preparation re-minted the key the image came with, which setup saw.
      expect(await inGuest("main", "cat /var/lib/clankerbox-live/setup-hostkey")).not.toBe(
        made.hostKey,
      );
    },
    minutes(10),
  );

  test(
    "scp and rsync move a binary file both ways through the forwarder, pinned to the machine's host key",
    async () => {
      const target = await machine("main");
      const endpoint = target?.ssh;

      if (target === undefined || endpoint === undefined) {
        throw new Error("main has no endpoint");
      }

      for (let sample = 0; sample < 3; sample += 1) {
        const connecting = performance.now();

        await inGuest("main", "true");
        timing("clankerbox ssh main true (connect through the forwarder)", connecting);
      }

      const options = await pinned(target);
      const local = await writeFileIn(dir, "upload.bin", randomBytes(256 * 1024));
      const remote = `admin@${endpoint.host}`;
      const port = String(endpoint.port);
      const started = performance.now();
      const up = await run("scp", [...options, "-P", port, local, `${remote}:up.bin`]);
      const down = join(dir, "scp-down.bin");
      const back = await run("scp", [...options, "-P", port, `${remote}:up.bin`, down]);
      const rsh = ["ssh", ...options, "-p", port].join(" ");
      const synced = join(dir, "rsync-down.bin");
      const rsyncUp = await run("rsync", ["-a", "-e", rsh, local, `${remote}:rsync-up.bin`]);
      const rsyncDown = await run("rsync", ["-a", "-e", rsh, `${remote}:rsync-up.bin`, synced]);

      timing("scp and rsync of 256 KiB, each way", started);

      for (const ran of [up, back, rsyncUp, rsyncDown]) {
        expect(ran.code, ran.stderr).toBe(0);
      }

      const expected = sha256(await readFile(local));

      expect(sha256(await readFile(down))).toBe(expected);
      expect(sha256(await readFile(synced))).toBe(expected);
      expect(await inGuest("main", "shasum -a 256 up.bin rsync-up.bin | cut -d ' ' -f 1")).toBe(
        `${expected}\n${expected}`,
      );
    },
    minutes(5),
  );

  test(
    "under Softnet a guest can't reach its host's API port or any of the host's addresses, and reaches the internet by name",
    async () => {
      const api = new URL(env.host.url);
      const listener = (await control("listener")).stdout;
      const gateway = await inGuest("main", "route -n get default | awk '/gateway:/ {print $2}'");
      const addresses = new Set([...(await controlled(Names, "addresses")), gateway]);

      expect(listener).toMatch(/^\d+$/u);

      const targets = [
        [api.hostname, api.port],
        ...[...addresses].map((address) => [address, listener] as const),
      ] as const;

      for (const [address, port] of targets) {
        expect(await probe(address, port), `${address}:${port} from the host`).toBe("reached");
        expect(
          await inGuest("main", guestProbe(address, port)),
          `${address}:${port} from the guest`,
        ).toBe("refused");
      }

      // The same probe reaches the internet, so the refusals are Softnet's block of the host.
      expect(await inGuest("main", guestProbe("1.1.1.1", "443"))).toBe("reached");
      expect(
        await inGuest(
          "main",
          "curl -sS -m 30 -o /dev/null -w '%{http_code}' https://one.one.one.one/",
        ),
      ).toMatch(/^[23]\d\d$/u);
    },
    minutes(5),
  );

  test(
    "a capture or a fork of a running machine is Precondition and writes nothing",
    async () => {
      const capture = failure(
        await cli(["checkpoint", "capture"], id("main"), named("hot"), "--json"),
      );

      const fork = failure(await cli(["fork"], id("main"), named("hot-fork"), "--json"));

      for (const refused of [capture, fork]) {
        expect(refused.tag).toBe("Precondition");
        expect(refused.message).toContain("stop it first");
      }

      expect(decode(Checkpoints, await cli(["checkpoint", "list"], "--json")).checkpoints).toEqual(
        [],
      );
      expect(await machine("hot-fork")).toBeUndefined();
      expect(await natives("hot")).toEqual(nothing);
      expect(await natives("hot-fork")).toEqual(nothing);
      expect(await machine("main")).toMatchObject({
        state: "running",
        action: { name: "create", status: "done" },
      });
    },
    minutes(3),
  );

  test(
    "stop and a cold start keep the machine's files, endpoint and key, and run start but not setup or new-identity; a stopped machine's port accepts and closes",
    async () => {
      const before = await machine("main");

      if (before?.ssh === undefined) {
        throw new Error("main has no endpoint");
      }

      let started = performance.now();
      const stopped = await cli(["stop"], id("main"), "--json");

      timing("stop (shutdown in the guest)", started);
      expect(stopped.code, stopped.stdout).toBe(0);
      expect(decode(OneMachine, stopped)).toMatchObject({
        state: "stopped",
        action: { name: "stop", status: "done" },
      });
      expect(await answer(before.ssh)).toBe("closed");

      const again = await cli(["stop"], id("main"), "--json");

      expect(decode(OneMachine, again).action).toEqual({ name: "stop", status: "done" });

      started = performance.now();

      const coldStart = await cli(["start"], id("main"), "--json");

      timing("start (cold, with preparation)", started);
      expect(coldStart.code, coldStart.stdout).toBe(0);

      const after = decode(OneMachine, coldStart);

      expect(after).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
      expect(after.hostKey).toBe(before.hostKey);
      expect(after.ssh).toEqual(before.ssh);
      expect(await facts("main")).toMatchObject({ identities: 1, starts: 2, setups: 1 });
    },
    minutes(5),
  );

  test(
    "a re-mint on start gives a fresh host key, which becomes Machine.hostKey, and the old pin is refused",
    async () => {
      const before = await machine("main");

      if (before?.ssh === undefined) {
        throw new Error("main has no endpoint");
      }

      const removed = await control("guest", named("main"), "rm /var/lib/clankerbox/instance");

      expect(removed.code, removed.stderr).toBe(0);

      const started = performance.now();
      const reminted = await cli(["start"], id("main"), "--json");

      timing("start (running machine: re-mint and start)", started);
      expect(reminted.code, reminted.stdout).toBe(0);

      const after = decode(OneMachine, reminted);

      expect(after.hostKey).toMatch(/^ssh-ed25519 /u);
      expect(after.hostKey).not.toBe(before.hostKey);
      expect(await facts("main")).toMatchObject({ identities: 2, starts: 3 });

      const stale = await run("ssh", [
        ...(await pinned(before)),
        "-p",
        String(before.ssh.port),
        `admin@${before.ssh.host}`,
        "true",
      ]);

      expect(stale.code).toBe(255);
      expect(stale.stderr).toMatch(/host key|HOST IDENTIFICATION/iu);
    },
    minutes(5),
  );

  test(
    "a disk checkpoint of a stopped machine, a fork of it and a restore: each copy gets its own port, host key and identity, carries the disk, and runs new-identity and start",
    async () => {
      const marker = randomBytes(8).toString("hex");

      await inGuest("main", `echo ${marker} >~/live-disk; sync`);

      const source = await facts("main");

      expect((await cli(["stop"], id("main"), "--json")).code).toBe(0);

      let started = performance.now();
      const captured = await cli(["checkpoint", "capture"], id("main"), named("snap"), "--json");

      timing("capture disk (clone of the stopped machine)", started);
      expect(captured.code, captured.stdout).toBe(0);
      expect(decode(OneCheckpoint, captured)).toMatchObject({
        id: id("snap"),
        machine: id("main"),
        kind: "disk",
        action: { name: "capture", status: "done" },
      });
      expect(await natives("snap")).toMatchObject({
        machines: [{ state: "stopped" }],
        jobs: [],
        files: [],
      });

      const timed = async (label: string, ran: Promise<Ran>) => {
        const begun = performance.now();
        const result = await ran;

        timing(label, begun);

        return result;
      };

      started = performance.now();

      const [forked, restored] = await Promise.all([
        timed(
          "fork (booting beside a restore)",
          cli(["fork"], id("main"), named("fork-a"), "--json"),
        ),
        timed(
          "restore (booting beside a fork)",
          cli(["restore"], id("snap"), named("restore-a"), "--json"),
        ),
      ]);

      timing("a fork and a restore, booting together", started);
      expect(forked.code, forked.stdout).toBe(0);
      expect(restored.code, restored.stdout).toBe(0);

      const all = await Promise.all(["main", "fork-a", "restore-a"].map(machine));
      const ports = [mainEndpoint.port, all[1]?.ssh?.port, all[2]?.ssh?.port];

      // main is stopped, so a list reports no endpoint for it; its port is the one create gave.
      expect(new Set(ports.filter((port) => port !== undefined)).size).toBe(3);
      expect(new Set(all.map((listed) => listed?.hostKey)).size).toBe(3);
      expect(all[0]?.state).toBe("stopped");

      for (const [index, name] of ["fork-a", "restore-a"].entries()) {
        expect(all[index + 1]).toMatchObject({
          state: "running",
          cpu: 2,
          ramMib: 4096,
          diskGib: 50,
          action: { name: index === 0 ? "fork" : "restore", status: "done" },
        });

        // clankerbox ssh pins the copy's hostKey, so this also shows sshd serves the new key.
        expect(await facts(name)).toEqual({
          machineId: id(name),
          instance: expect.not.stringMatching(source.instance),
          disk: marker,
          identities: source.identities + 1,
          starts: source.starts + 1,
          setups: 1,
        });
      }
    },
    minutes(10),
  );

  test(
    "with two VMs running, Apple's limit refuses a third create and a start with Capacity before any clone, writing nothing; one list reads every machine's state",
    async () => {
      const states = Object.fromEntries(
        (await machines()).machines.map(({ id: listedId, state }) => [listedId, state]),
      );

      expect(states).toEqual({
        [id("main")]: "stopped",
        [id("fork-a")]: "running",
        [id("restore-a")]: "running",
      });

      const third = failure(await createBare("third"));

      expect(third.tag).toBe("Capacity");
      expect(third.message).toContain("Apple allows 2");
      expect(await machine("third")).toBeUndefined();
      expect(await natives("third")).toEqual(nothing);

      const start = failure(await cli(["start"], id("main"), "--json"));

      expect(start.tag).toBe("Capacity");
      expect(await machine("main")).toMatchObject({
        state: "stopped",
        action: { name: "fork", status: "done" },
      });
    },
    minutes(3),
  );

  test(
    "a host restart keeps the VMs running, brings their forwarded endpoints back, and listens again for a stopped machine",
    async () => {
      const before = await machines();
      const boots = await Promise.all(["fork-a", "restore-a"].map(bootTime));
      const fork = await machine("fork-a");

      if (fork?.ssh === undefined) {
        throw new Error("fork-a has no endpoint");
      }

      expect((await control("host-stop")).code).toBe(0);
      expect(await answer(fork.ssh)).toBe("refused");

      const started = performance.now();

      expect((await control("host-start")).code).toBe(0);
      timing("host start (listeners for every machine)", started);
      expect(await machines()).toEqual(before);
      expect(await Promise.all(["fork-a", "restore-a"].map(bootTime))).toEqual(boots);
      expect(await answer(fork.ssh)).toBe("banner");
      expect(await answer(mainEndpoint)).toBe("closed");
    },
    minutes(5),
  );

  test(
    "delete removes a running machine's VM, job and listener, and a checkpoint delete its VM",
    async () => {
      let started = performance.now();

      await removeMachine("restore-a");
      timing("delete (running machine)", started);
      started = performance.now();

      const deleted = await cli(["checkpoint", "delete"], id("snap"), "--json");

      timing("checkpoint delete", started);
      expect(deleted.code, deleted.stdout).toBe(0);
      expect(await natives("snap")).toEqual(nothing);
      expect(decode(Checkpoints, await cli(["checkpoint", "list"], "--json")).checkpoints).toEqual(
        [],
      );
    },
    minutes(3),
  );

  test(
    "after the host is killed during a create's setup, the row reads failed; stop stops the machine, never made, start, fork and capture refuse it, writing nothing, and delete removes its VM, job and listener",
    async () => {
      let ended: Ran | undefined;

      const creating = createWith(
        "crash",
        "#!/bin/sh\ntouch /var/tmp/clankerbox-live-setup-started\nsleep 300\n",
        600,
      ).then((ran) => {
        ended = ran;

        return ran;
      });

      await waitFor(
        "crash's setup to start",
        async () => {
          if (ended !== undefined) {
            throw new Error(`crash's create ended before the kill: ${ended.stdout}`);
          }

          return (
            (
              await control(
                "guest",
                named("crash"),
                "test -e /var/tmp/clankerbox-live-setup-started",
              )
            ).code === 0
          );
        },
        300,
      );
      expect((await control("host-kill")).code).toBe(0);

      const lost = failure(await creating);

      expect(lost.tag).toBe("Unavailable");
      expect(lost.message).toContain("may have run");
      expect((await control("host-start")).code).toBe(0);

      const crashed = await machine("crash");

      expect(crashed).toMatchObject({
        state: "running",
        action: {
          name: "create",
          status: "failed",
          error: { tag: "Internal", message: "host restarted during create" },
        },
      });

      const stopped = await cli(["stop"], id("crash"), "--json");

      expect(stopped.code, stopped.stdout).toBe(0);
      expect(decode(OneMachine, stopped)).toMatchObject({
        state: "stopped",
        action: { name: "stop", status: "done" },
      });

      for (const [command, ...args] of [
        [["start"]],
        [["fork"], named("crash-fork")],
        [["checkpoint", "capture"], named("crash-snap")],
      ] as const) {
        const refused = failure(await cli(command, id("crash"), ...args, "--json"));

        expect(refused.tag, command.join(" ")).toBe("Precondition");
        expect(refused.message, command.join(" ")).toContain("was never made");
      }

      expect(await machine("crash-fork")).toBeUndefined();
      expect(await natives("crash-fork")).toEqual(nothing);
      expect(await natives("crash-snap")).toEqual(nothing);
      expect(decode(Checkpoints, await cli(["checkpoint", "list"], "--json")).checkpoints).toEqual(
        [],
      );

      const started = performance.now();

      await removeMachine("crash", crashed?.ssh);
      timing("delete (never made, stopped)", started);
    },
    minutes(10),
  );

  test(
    "a diskGib below the base's disk fails the create at tart set, leaving the machine never made, which delete removes",
    async () => {
      const started = performance.now();
      const error = failure(await createBare("small", 20));

      timing("create refused at tart set", started);
      expect(error.tag).toBe("Internal");
      expect(error.message).toContain("tart set");
      expect(await machine("small")).toMatchObject({
        state: "stopped",
        action: { name: "create", status: "failed" },
      });

      const refused = failure(await cli(["start"], id("small"), "--json"));

      expect(refused.tag).toBe("Precondition");
      expect(refused.message).toContain("was never made");
      await removeMachine("small");
      expect(await machine("small")).toBeUndefined();
    },
    minutes(5),
  );

  test(
    "delete removes the last machines, a fork and its stopped source",
    async () => {
      await removeMachine("fork-a");
      await removeMachine("main", mainEndpoint);
      expect((await machines()).machines).toEqual([]);
    },
    minutes(3),
  );
});

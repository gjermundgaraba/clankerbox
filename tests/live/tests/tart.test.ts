/**
 * Live acceptance on a Tart host, through the CLI: lifecycle, setup and preparation on macOS
 * guests, the forwarder, Softnet, placement over two hosts, disk checkpoints and forks, Apple's
 * two-VM limit, a host restart and a crash. Apple runs at most two macOS VMs per Mac, so at most two of the run's VMs
 * run at once. The tests run in order and share `main`, whose setup sets public resolvers,
 * installs the run's key for `admin`, and writes a `start` and a `new-identity` hook; the test
 * that made any other machine deletes it. Timings print as `[timing]` lines.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { SshEndpoint } from "@gjermundgaraba/clankerbox-sdk";
import { describe, expect, test } from "vite-plus/test";
import {
  Checkpoints,
  decode,
  harness,
  liveOn,
  Machines,
  minutes,
  Names,
  OneCheckpoint,
  OneMachine,
  type Ran,
  rebased,
  refusedBeforeTheRuntime,
  type Runtime,
  run,
  sha256,
  TartNatives,
  timing,
  waitFor,
  writeFileIn,
} from "./live.ts";

/**
 * The setup of `main`. Softnet's block of the host also blocks the gateway's DNS, so public
 * resolvers come first (README, Runtime notes). `admin` is the Cirrus image's user. Setup
 * runs before preparation, so it records the image's host key, which preparation replaces.
 */
const mainScript = (publicKey: string) => `#!/bin/sh
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

/** What the harness drives a Tart host with. */
const tart: Runtime<typeof TartNatives.Type> = {
  /** The Cirrus image's user. */
  user: "admin",
  /** The base's disk is 50 GB, and Tart only grows a disk (README, Runtime notes). */
  sizes: (diskGib = 50) => [
    "--base",
    "macos",
    "--cpu",
    "2",
    "--ram-mib",
    "4096",
    "--disk-gib",
    String(diskGib),
  ],
  /** The VMs, launchd jobs and job files of the machine or checkpoint named `name` on the host. */
  natives: (controlled, name) => controlled(TartNatives, "natives", name),
  nothing: { machines: [], jobs: [], files: [] },
  mainSetup: (dir, publicKey) => writeFileIn(dir, "main-setup.sh", mainScript(publicKey), 0o755),
};

describe.skipIf(!liveOn("tart"))("a Tart host, through the CLI", () => {
  const suite = harness(tart);

  const {
    cli,
    cliWith,
    named,
    id,
    control,
    controlled,
    machines,
    machine,
    createBare,
    createWith,
    inGuest,
    facts,
    pinned,
    failure,
    natives,
    probe,
  } = suite;

  /** Deletes the machine as the harness does, then checks that its listener is gone too. */
  const removeMachine = async (name: string) => {
    const endpoint = (await machine(name))?.ssh;

    await suite.removeMachine(name);

    if (endpoint !== undefined) {
      expect(await answer(endpoint)).toBe("refused");
    }
  };

  /** When the guest booted; a VM that kept running keeps it. */
  const bootTime = (name: string) => inGuest(name, "sysctl -n kern.boottime");

  test(
    "create runs setup once and then preparation, and reports the forwarder's endpoint and a fresh host key",
    async () => {
      const started = performance.now();

      const ran = await cli(
        ["create"],
        id("main"),
        ...tart.sizes(),
        "--setup",
        suite.mainSetup,
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
        ssh: { host: new URL(suite.env.host.url).hostname },
      });
      expect(made.ssh?.port).toBeGreaterThanOrEqual(10_000);
      expect(made.ssh?.port).toBeLessThanOrEqual(19_999);
      expect(made.hostKey).toMatch(/^ssh-ed25519 /u);

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
      const local = await writeFileIn(suite.dir, "upload.bin", randomBytes(256 * 1024));
      const remote = `admin@${endpoint.host}`;
      const port = String(endpoint.port);
      const started = performance.now();
      const up = await run("scp", [...options, "-P", port, local, `${remote}:up.bin`]);
      const down = join(suite.dir, "scp-down.bin");
      const back = await run("scp", [...options, "-P", port, `${remote}:up.bin`, down]);
      const rsh = ["ssh", ...options, "-p", port].join(" ");
      const synced = join(suite.dir, "rsync-down.bin");
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

  refusedBeforeTheRuntime(suite, tart, "main");

  test(
    "under Softnet a guest can't reach its host's API port or any of the host's addresses, and reaches the internet by name",
    async () => {
      const api = new URL(suite.env.host.url);
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
      expect(await natives("hot")).toEqual(tart.nothing);
      expect(await natives("hot-fork")).toEqual(tart.nothing);
      expect(await machine("main")).toMatchObject({
        state: "running",
        action: { name: "create", status: "done" },
      });
    },
    minutes(3),
  );

  test(
    "placement: a create by name lands on the first host in list order that offers its base, a full ID and a profile's host send it to that host, and a base no host offers is Precondition naming each host's bases",
    async () => {
      const { host, second } = suite.env;

      if (second === undefined) {
        throw new Error(
          "the Tart driver runs a second host, which CLANKERBOX_LIVE_PLACEMENT_CONFIG names",
        );
      }

      const secondFirst = await writeFileIn(
        suite.dir,
        "second-first.json",
        JSON.stringify({ hosts: [second, host] }),
      );

      const hostFirst = await writeFileIn(
        suite.dir,
        "host-first.json",
        JSON.stringify({ hosts: [host, second] }),
      );

      const profile = await writeFileIn(
        suite.dir,
        "placed.json",
        JSON.stringify({ base: "macos", cpu: 2, ramMib: 4096, diskGib: 20, host: host.id }),
      );

      // Each create asks for a disk below the base's, which `tart set` refuses once the chosen
      // host has cloned the base: the row stays there, failed, and no VM boots.
      const small = tart.sizes(20);

      const placed = [
        // Both hosts offer macos, and the second is listed first.
        [secondFirst, named("pl-first"), small, second.id],
        // Only the second host offers macos-b, and it is listed last.
        [hostFirst, named("pl-skip"), rebased(small, "macos-b"), second.id],
        // A full ID names the host, whatever placement by base would pick.
        [secondFirst, id("pl-full"), small, host.id],
        // So does the profile's host.
        [secondFirst, named("pl-prof"), ["--profile", profile], host.id],
      ] as const;

      for (const [config, target, args] of placed) {
        const error = failure(await cliWith(config, ["create"], target, ...args, "--json"));

        expect(error.tag, target).toBe("Precondition");
        expect(error.message, target).toContain("should be larger than the current disk size");
      }

      const nowhere = failure(
        await cliWith(
          hostFirst,
          ["create"],
          named("pl-none"),
          ...rebased(small, "nowhere"),
          "--json",
        ),
      );

      expect(nowhere.tag).toBe("Precondition");
      expect(nowhere.message).toContain("no host offers base nowhere");
      expect(nowhere.message).toContain(`${host.id} offers macos`);
      expect(nowhere.message).toContain(`${second.id} offers`);
      expect(nowhere.message).toContain("macos-b");

      const listed = decode(Machines, await cliWith(secondFirst, ["machines"], "--json"));

      expect(listed.unreachable).toEqual([]);
      expect(
        Object.fromEntries(listed.machines.map((row) => [row.id, [row.action, row.profile]])),
      ).toEqual({
        [id("main")]: [{ name: "create", status: "done" }, undefined],
        [`${second.id}_${named("pl-first")}`]: [
          expect.objectContaining({ status: "failed" }),
          undefined,
        ],
        [`${second.id}_${named("pl-skip")}`]: [
          expect.objectContaining({ status: "failed" }),
          undefined,
        ],
        [id("pl-full")]: [expect.objectContaining({ status: "failed" }), undefined],
        [id("pl-prof")]: [expect.objectContaining({ status: "failed" }), "placed"],
      });

      for (const [, target, , landed] of placed) {
        const name = target.slice(target.indexOf("_") + 1);
        const full = target.includes("_") ? target : `${landed}_${target}`;
        const deleted = await cliWith(secondFirst, ["delete"], full, "--json");

        expect(deleted.code, deleted.stdout).toBe(0);
        expect(await controlled(TartNatives, "natives", name, landed)).toEqual(tart.nothing);
      }

      expect(
        decode(Machines, await cliWith(secondFirst, ["machines"], "--json")).machines.map(
          (row) => row.id,
        ),
      ).toEqual([id("main")]);
    },
    minutes(5),
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
        ssh: before.ssh,
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
      const ports = all.map((listed) => listed?.ssh?.port);

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
      expect(await natives("third")).toEqual(tart.nothing);

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
      const [fork, main] = await Promise.all(["fork-a", "main"].map(machine));

      if (fork?.ssh === undefined || main?.ssh === undefined) {
        throw new Error("fork-a or main has no endpoint");
      }

      expect((await control("host-stop")).code).toBe(0);
      expect(await answer(fork.ssh)).toBe("refused");

      const started = performance.now();

      expect((await control("host-start")).code).toBe(0);
      timing("host start (listeners for every machine)", started);
      expect(await machines()).toEqual(before);
      expect(await Promise.all(["fork-a", "restore-a"].map(bootTime))).toEqual(boots);
      expect(await answer(fork.ssh)).toBe("banner");
      expect(await answer(main.ssh)).toBe("closed");
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
      expect(await natives("snap")).toEqual(tart.nothing);
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
        2000,
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
      expect(await natives("crash-fork")).toEqual(tart.nothing);
      expect(await natives("crash-snap")).toEqual(tart.nothing);
      expect(decode(Checkpoints, await cli(["checkpoint", "list"], "--json")).checkpoints).toEqual(
        [],
      );

      const started = performance.now();

      await removeMachine("crash");
      timing("delete (never made, stopped)", started);
    },
    minutes(10),
  );

  test(
    "a diskGib below the base's disk fails the create at tart set with Precondition, leaving the machine never made, which delete removes",
    async () => {
      const started = performance.now();
      const error = failure(await createBare("small", 20));

      timing("create refused at tart set", started);
      expect(error.tag).toBe("Precondition");
      expect(error.message).toContain("should be larger than the current disk size");
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
      await removeMachine("main");
      expect((await machines()).machines).toEqual([]);
    },
    minutes(3),
  );
});

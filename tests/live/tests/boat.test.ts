/**
 * Live acceptance on a boat host, through the CLI, on boat's trial: lifecycle, setup and
 * preparation, ssh, scp and rsync through boat's endpoint, stop and resume, disk forks of a
 * running and a stopped machine, named-snapshot checkpoints, boat's refusals, a host restart and
 * a crash.
 *
 * The trial runs 2 sandboxes at once and allows 5 starts a minute, 25 an hour and 75 a day; a
 * create, fork, resume and restore each count, and so does a 429 refusal, but not a 403 for a
 * type the plan lacks (the bump-boat-api skill). So at most two of the run's sandboxes are
 * active at once, and every start goes through `counted`, which keeps them to `startsPerMinute`
 * and prints a `[start]` line that the driver counts: one run makes 7, the 429 included.
 *
 * The driver passes the account's limit of active sandboxes in
 * `CLANKERBOX_LIVE_BOAT_ACTIVE_LIMIT`, and its tier in `CLANKERBOX_LIVE_BOAT_TIER`. Unless the
 * limit is the trial's 2, the test of that 429 is skipped, since it would make a third sandbox;
 * unless the tier is `trial`, so is the large create, which a plan with `large` would make. The
 * rest run. The account may hold the operator's own sandboxes and snapshots, which the
 * host-control program's `account` counts but never names.
 *
 * The tests run in order and share `main`, whose setup authorizes the run's key for root, and
 * writes a `start` and a `new-identity` hook; the test that made any other machine deletes it,
 * the copies only once `main` is gone, since a checkpoint must restore after its source is
 * deleted. Timings print as `[timing]` lines.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Machine } from "@gjermundgaraba/clankerbox-sdk";
import { afterAll, describe, expect, test } from "vite-plus/test";
import {
  BoatAccount,
  BoatNatives,
  Checkpoints,
  decode,
  Failure,
  harness,
  liveOn,
  minutes,
  Names,
  OneCheckpoint,
  OneMachine,
  type Ran,
  refusedBeforeTheRuntime,
  type Runtime,
  run,
  sha256,
  timing,
  waitFor,
  writeFileIn,
} from "./live.ts";

/**
 * The setup of `main`. boat's sshd accepts root with a key, so the run's key goes to root, and
 * `user`'s `authorized_keys`, which boat's own access needs, is left alone. Setup runs before
 * preparation, so it records the host key the sandbox came with, which preparation replaces.
 * rsync goes in if the image lacks it; an install that fails fails only the transfer test.
 */
const mainScript = (publicKey: string) => `#!/bin/sh
set -eu
command -v rsync >/dev/null || {
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends rsync >/dev/null
} || echo "rsync didn't install"
install -d -m 700 /root/.ssh
printf '%s\\n' '${publicKey}' >>/root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
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

/**
 * The host's mark that the guest runs on the machine its create made, which no snapshot carries,
 * and boat's marker that a fork, resume or restore has restored `/var/lib` in full
 * (packages/host/src/boat.ts).
 */
const createdMark = "/run/clankerbox-created";

const restoredMarker = "/var/lib/ascii-lazy/sys-done";

/** The states of a sandbox that runs. */
const upStates = ["ready", "idle", "running"];

/** boat's trial allows 5 starts a minute; the suite keeps to one fewer. */
const startsPerMinute = 4;

/** The trial's limit of active sandboxes, which the 429 test fills. */
const trialActive = 2;

/** The account's limit of active sandboxes, as the driver read it; the trial's when unset. */
const activeLimit = Number(process.env["CLANKERBOX_LIVE_BOAT_ACTIVE_LIMIT"] ?? trialActive);

/** Whether the account is on boat's trial, as the driver read its tier; the trial when unset. */
const onTrial = (process.env["CLANKERBOX_LIVE_BOAT_TIER"] ?? "trial") === "trial";

/** What the harness drives a boat host with. */
const boat: Runtime<typeof BoatNatives.Type> = {
  /** boat's sshd accepts root with a key, which `main`'s setup authorizes. */
  user: "root",
  /** boat's `small`, the trial's smallest type, exactly. */
  sizes: (cpu = 2, ramMib = 4096, diskGib = 12) => [
    "--base",
    "boat",
    "--cpu",
    String(cpu),
    "--ram-mib",
    String(ramMib),
    "--disk-gib",
    String(diskGib),
  ],
  /** The sandboxes whose display name is the machine's ID. */
  natives: (controlled, name) => controlled(BoatNatives, "natives", name),
  nothing: { sandboxes: [] },
  mainSetup: (dir, publicKey) => writeFileIn(dir, "main-setup.sh", mainScript(publicKey), 0o755),
};

/** How boat answered a start the CLI reports failed: `429` when boat refused it for a limit. */
const refusedWith = (ran: Ran) => {
  try {
    const { error } = decode(Failure, ran);

    return error.message.includes(" 429 ") ? "429" : error.tag;
  } catch {
    return "failed";
  }
};

describe.skipIf(!liveOn("boat"))("a boat host, through the CLI", () => {
  const suite = harness(boat);

  const {
    cli,
    named,
    id,
    target,
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
    removeMachine,
  } = suite;

  const ended: Array<number> = [];
  const outcomes: Array<string> = [];

  /**
   * Runs `call`, which makes boat start a sandbox, once fewer than `startsPerMinute` of the
   * run's starts fall in the last minute, and prints a `[start]` line, which the driver counts.
   * A start is timed when its call returns, since boat may start late in it (a running source's
   * fork, after its snapshot wait). Nothing repeats a start.
   */
  const counted = async (kind: string, name: string, call: () => Promise<Ran>) => {
    const recent = () => ended.filter((at) => performance.now() - at < 61_000);

    while (recent().length >= startsPerMinute) {
      const oldest = recent()[0] ?? performance.now();

      await new Promise((resolve) => setTimeout(resolve, 61_000 - (performance.now() - oldest)));
    }

    const ran = await call();

    ended.push(performance.now());
    const outcome = ran.code === 0 ? "ok" : refusedWith(ran);

    outcomes.push(outcome);
    console.log(`[start] ${kind} ${named(name)} ${outcome}`);

    return ran;
  };

  afterAll(() => {
    console.log(
      `[starts] ${outcomes.length}, ${outcomes.filter((outcome) => outcome === "429").length} refused with 429`,
    );
  });

  /** How many sandboxes and named snapshots the whole account holds. */
  const account = () => controlled(BoatAccount, "account");

  /** The names of the run's named snapshots. */
  const snapshots = () => controlled(Names, "snapshots");

  /** Which of the create's mark and boat's restore marker the guest holds, one per line. */
  const marks = (name: string) =>
    inGuest(
      name,
      `for mark in ${createdMark} ${restoredMarker}; do test -e $mark && echo $mark; done; true`,
    );

  /** The guest kernel's boot ID; a sandbox that kept running keeps it. */
  const bootId = (name: string) => inGuest(name, "cat /proc/sys/kernel/random/boot_id");

  /** Checks that ssh pinned to `before`'s host key is refused at `name`'s endpoint now. */
  const refusesPin = async (name: string, before: Machine) => {
    const now = await machine(name);

    if (now?.ssh === undefined) {
      throw new Error(`${name} has no endpoint`);
    }

    const stale = await run("ssh", [
      ...(await pinned(before)),
      "-p",
      String(now.ssh.port),
      `root@${now.ssh.host}`,
      "true",
    ]);

    expect(stale.code).toBe(255);
    expect(stale.stderr).toMatch(/host key|HOST IDENTIFICATION/iu);
  };

  /** The marker `main`'s disk holds from the stop test on, which its running capture carries. */
  const kept = randomBytes(8).toString("hex");

  /** What `main` showed when its running capture began. */
  let atCapture: Awaited<ReturnType<typeof facts>>;

  /**
   * The marker `main` writes just before its running capture, with no sync of its own: the
   * capture's sync puts it in the snapshot, which the restore reads.
   */
  const captured = randomBytes(8).toString("hex");

  test(
    "create runs setup once and then preparation, names the sandbox after the machine, and reports boat's endpoint and a fresh host key",
    async () => {
      const started = performance.now();

      const ran = await counted("create", "main", () =>
        cli(
          ["create"],
          ...target("main"),
          ...boat.sizes(),
          "--setup",
          suite.mainSetup,
          "--setup-timeout",
          "600",
          "--json",
        ),
      );

      timing("create with setup", started);
      expect(ran.code, ran.stdout).toBe(0);

      const made = decode(OneMachine, ran);

      expect(made).toMatchObject({
        id: id("main"),
        runtime: "boat",
        state: "running",
        cpu: 2,
        ramMib: 4096,
        diskGib: 12,
        action: { name: "create", status: "done" },
      });
      expect(made.ssh?.port).toBeGreaterThan(0);
      expect(made.hostKey).toMatch(/^ssh-ed25519 /u);

      const { sandboxes } = await natives("main");

      expect(sandboxes).toHaveLength(1);
      expect(upStates).toContain(sandboxes[0]?.state);

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
      // Preparation re-minted the key the sandbox came with, which setup saw.
      expect(await inGuest("main", "cat /var/lib/clankerbox-live/setup-hostkey")).not.toBe(
        made.hostKey,
      );
    },
    minutes(20),
  );

  test(
    "start of the running machine its create made, right after the create, leaves it running and doesn't wait for boat's restore marker, which a create never gets",
    async () => {
      const before = await machine("main");
      const boot = await bootId("main");
      const source = await facts("main");

      const created = await marks("main");

      // The create's SSH wait marked the guest's machine as the create's own. Whether boat wrote
      // its restore marker anyway is the bump-boat-api skill's to note.
      expect(created).toContain(createdMark);
      console.log(`[marker] after create: ${created.replaceAll("\n", " ") || "none"}`);

      const started = performance.now();
      const ran = await cli(["start"], id("main"), "--json");
      const took = performance.now() - started;

      timing("start (running machine its create made)", started);
      expect(ran.code, ran.stdout).toBe(0);

      const after = decode(OneMachine, ran);

      expect(after).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
      expect(after.ssh).toEqual(before?.ssh);
      // Far inside the marker wait's 10 minutes: SSH and preparation take seconds.
      expect(took).toBeLessThan(minutes(1));
      expect(await bootId("main")).toBe(boot);
      expect(await facts("main")).toEqual({ ...source, starts: source.starts + 1 });
    },
    minutes(5),
  );

  test(
    "scp and rsync move a binary file both ways through boat's endpoint, pinned to the machine's host key",
    async () => {
      const target = await machine("main");
      const endpoint = target?.ssh;

      if (target === undefined || endpoint === undefined) {
        throw new Error("main has no endpoint");
      }

      for (let sample = 0; sample < 3; sample += 1) {
        const connecting = performance.now();

        await inGuest("main", "true");
        timing("clankerbox ssh main true (through boat's endpoint)", connecting);
      }

      const options = await pinned(target);
      const local = await writeFileIn(suite.dir, "upload.bin", randomBytes(256 * 1024));
      const remote = `root@${endpoint.host}`;
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
      expect(await inGuest("main", "sha256sum up.bin rsync-up.bin | cut -d ' ' -f 1")).toBe(
        `${expected}\n${expected}`,
      );
    },
    minutes(5),
  );

  test(
    "a size no boat type covers is refused with Precondition before any call to boat, leaving no row and nothing on boat",
    async () => {
      const before = await account();
      const refused = failure(await createBare("big", 17));

      expect(refused.tag).toBe("Precondition");
      expect(refused.message).toContain("no boat machine type");
      expect(await machine("big")).toBeUndefined();
      expect(await natives("big")).toEqual(boat.nothing);
      expect(await account()).toEqual(before);
    },
    minutes(2),
  );

  refusedBeforeTheRuntime(suite, boat, "main");

  test.skipIf(!onTrial)(
    "a large create, which the trial's plan lacks, is boat's 403 and a Precondition refusal, leaving no row and nothing on boat",
    async () => {
      const before = await account();

      // 8 vCPU is boat's `large`, which the trial refuses. boat didn't count its 403 as a start
      // (the bump-boat-api skill), so it isn't `counted`; the driver's account count before and
      // after shows if it ever does.
      const large = failure(await createBare("large", 8));

      expect(large.tag).toBe("Precondition");
      expect(large.message).toContain("403 trial_machine_class_not_allowed");
      expect(await machine("large")).toBeUndefined();
      expect(await natives("large")).toEqual(boat.nothing);
      expect(await account()).toEqual(before);
    },
    minutes(2),
  );

  test(
    "stop archives the sandbox and start resumes it on a new machine: a new endpoint and host key, files in /root and /var/lib kept, and start run but not setup or new-identity",
    async () => {
      await inGuest(
        "main",
        `echo ${kept} >~/live-disk; echo ${kept} >/var/lib/clankerbox-live/kept; sync`,
      );

      const before = await machine("main");
      const source = await facts("main");

      if (before?.ssh === undefined) {
        throw new Error("main has no endpoint");
      }

      let started = performance.now();
      const stopped = await cli(["stop"], id("main"), "--json");

      timing("stop (boat's final snapshot, then archived)", started);
      expect(stopped.code, stopped.stdout).toBe(0);

      const down = decode(OneMachine, stopped);

      expect(down).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
      expect(down.ssh).toBeUndefined();
      expect(await natives("main")).toEqual({
        sandboxes: [{ id: expect.any(String), state: "archived" }],
      });

      const again = await cli(["stop"], id("main"), "--json");

      expect(decode(OneMachine, again).action).toEqual({ name: "stop", status: "done" });

      started = performance.now();

      const resumed = await counted("resume", "main", () => cli(["start"], id("main"), "--json"));

      timing("start (resume, then boat's marker and preparation)", started);
      expect(resumed.code, resumed.stdout).toBe(0);

      const after = decode(OneMachine, resumed);

      expect(after).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
      expect(after.hostKey).toMatch(/^ssh-ed25519 /u);
      expect(after.hostKey).not.toBe(before.hostKey);
      expect(after.ssh).not.toEqual(before.ssh);
      // Preparation found /var/lib/clankerbox from before the stop: the same instance, no
      // new-identity.
      expect(await facts("main")).toEqual({
        ...source,
        disk: kept,
        starts: source.starts + 1,
      });
      expect(await inGuest("main", "cat /var/lib/clankerbox-live/kept")).toBe(kept);
      // The resume's fresh machine doesn't carry the create's mark, so the start waited for
      // boat's marker.
      expect(await marks("main")).toBe(restoredMarker);
      await refusesPin("main", before);
    },
    minutes(25),
  );

  test(
    "a re-mint on start of a running machine gives a fresh host key, which becomes Machine.hostKey, without a resume, and the old pin is refused",
    async () => {
      const before = await machine("main");
      const boot = await bootId("main");

      if (before === undefined) {
        throw new Error("main is gone");
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
      expect(after.ssh).toEqual(before.ssh);
      expect(await bootId("main")).toBe(boot);
      expect(await facts("main")).toMatchObject({ identities: 2, starts: 4, setups: 1 });
      await refusesPin("main", before);
    },
    minutes(5),
  );

  test(
    "a checkpoint captures a running machine, a file written just before it included (the restore reads it), and a fork of it, once a snapshot begun after its sync has completed, holds a file written just before while the source keeps running",
    async () => {
      atCapture = await facts("main");
      await inGuest("main", `echo ${captured} >~/live-capture`);

      let started = performance.now();
      const capture = await cli(["checkpoint", "capture"], id("main"), named("snap"), "--json");

      timing("capture (named snapshot of a running sandbox)", started);
      expect(capture.code, capture.stdout).toBe(0);
      expect(decode(OneCheckpoint, capture)).toMatchObject({
        id: id("snap"),
        machine: id("main"),
        kind: "disk",
        action: { name: "capture", status: "done" },
      });
      expect(await snapshots()).toHaveLength(1);

      const marker = randomBytes(8).toString("hex");
      const boot = await bootId("main");
      const source = await machine("main");

      await inGuest("main", `echo ${marker} >~/live-disk`);
      started = performance.now();

      const forked = await counted("fork", "fork-a", () =>
        cli(["fork"], id("main"), named("fork-a"), "--json"),
      );

      timing("fork of a running machine (sync, a fresh snapshot, then the fork)", started);
      expect(forked.code, forked.stdout).toBe(0);
      expect(decode(OneMachine, forked)).toMatchObject({
        id: id("fork-a"),
        state: "running",
        cpu: 2,
        ramMib: 4096,
        diskGib: 12,
        action: { name: "fork", status: "done" },
      });

      const copy = await machine("fork-a");

      expect(copy?.hostKey).not.toBe(source?.hostKey);
      expect(copy?.ssh).not.toEqual(source?.ssh);
      expect(await bootId("main")).toBe(boot);
      expect(await machine("main")).toMatchObject({ state: "running" });
      expect(await facts("fork-a")).toEqual({
        machineId: id("fork-a"),
        instance: expect.not.stringMatching(atCapture.instance),
        disk: marker,
        identities: atCapture.identities + 1,
        starts: atCapture.starts + 1,
        setups: 1,
      });
      // The fork's fresh machine carries no mark, and holds boat's marker.
      expect(await marks("fork-a")).toBe(restoredMarker);
    },
    minutes(50),
  );

  test.skipIf(activeLimit !== trialActive)(
    "with two sandboxes active, boat refuses a third create with 429: Capacity, leaving no row and nothing on boat",
    async () => {
      const states = Object.fromEntries(
        (await machines()).machines.map(({ id: listedId, state }) => [listedId, state]),
      );

      expect(states).toEqual({ [id("main")]: "running", [id("fork-a")]: "running" });

      const before = await account();
      const third = failure(await counted("create", "third", () => createBare("third")));

      expect(third.tag).toBe("Capacity");
      expect(third.message).toContain("limit_reached");
      expect(await machine("third")).toBeUndefined();
      expect(await natives("third")).toEqual(boat.nothing);
      expect(await account()).toEqual(before);
    },
    minutes(3),
  );

  test(
    "a host restart keeps the sandboxes running and reads the same machines",
    async () => {
      const before = await machines();
      const boots = await Promise.all(["main", "fork-a"].map(bootId));

      expect((await control("host-stop")).code).toBe(0);

      const started = performance.now();

      expect((await control("host-start")).code).toBe(0);
      timing("host start", started);
      expect(await machines()).toEqual(before);
      expect(await Promise.all(["main", "fork-a"].map(bootId))).toEqual(boots);
    },
    minutes(5),
  );

  test(
    "delete removes a running machine's sandbox once boat answers 404",
    async () => {
      const started = performance.now();

      await removeMachine("fork-a");
      timing("delete (running machine)", started);
      expect(await machine("fork-a")).toBeUndefined();
    },
    minutes(3),
  );

  test(
    "a stopped machine captures, then forks at once, the fork holding everything up to the stop",
    async () => {
      const source = await facts("main");

      expect((await cli(["stop"], id("main"), "--json")).code).toBe(0);

      let started = performance.now();

      const captured = await cli(
        ["checkpoint", "capture"],
        id("main"),
        named("snap-cold"),
        "--json",
      );

      timing("capture (named snapshot of a stopped sandbox)", started);
      expect(captured.code, captured.stdout).toBe(0);
      expect(decode(OneCheckpoint, captured)).toMatchObject({
        kind: "disk",
        action: { name: "capture", status: "done" },
      });
      expect(await snapshots()).toHaveLength(2);
      started = performance.now();

      const forked = await counted("fork", "fork-b", () =>
        cli(["fork"], id("main"), named("fork-b"), "--json"),
      );

      timing("fork of a stopped machine", started);
      expect(forked.code, forked.stdout).toBe(0);
      expect(await machine("main")).toMatchObject({ state: "stopped" });
      expect(await facts("fork-b")).toEqual({
        machineId: id("fork-b"),
        instance: expect.not.stringMatching(source.instance),
        disk: source.disk,
        identities: source.identities + 1,
        starts: source.starts + 1,
        setups: 1,
      });
      expect(await marks("fork-b")).toBe(restoredMarker);
    },
    minutes(40),
  );

  test(
    "a fork keeps running once its source is deleted, and a checkpoint captured from the running source restores after it: its own endpoint, host key and identity, with the disk as captured, the file written just before the capture included",
    async () => {
      await removeMachine("main");
      expect(await inGuest("fork-b", "echo up")).toBe("up");

      const started = performance.now();

      const restored = await counted("restore", "restore-a", () =>
        cli(["restore"], id("snap"), named("restore-a"), "--json"),
      );

      timing("restore (create from a named snapshot)", started);
      expect(restored.code, restored.stdout).toBe(0);
      expect(decode(OneMachine, restored)).toMatchObject({
        id: id("restore-a"),
        state: "running",
        cpu: 2,
        ramMib: 4096,
        diskGib: 12,
        action: { name: "restore", status: "done" },
      });

      const copies = await Promise.all(["fork-b", "restore-a"].map(machine));

      expect(new Set(copies.map((copy) => copy?.hostKey)).size).toBe(2);
      expect(copies[0]?.ssh).not.toEqual(copies[1]?.ssh);
      expect(await facts("restore-a")).toEqual({
        machineId: id("restore-a"),
        instance: expect.not.stringMatching(atCapture.instance),
        disk: kept,
        identities: atCapture.identities + 1,
        starts: atCapture.starts + 1,
        setups: 1,
      });
      expect(await inGuest("restore-a", "cat ~/live-capture")).toBe(captured);
      expect(await marks("restore-a")).toBe(restoredMarker);
    },
    minutes(30),
  );

  test(
    "checkpoint delete removes the named snapshots, and delete the running copies",
    async () => {
      for (const name of ["snap", "snap-cold"]) {
        const started = performance.now();
        const deleted = await cli(["checkpoint", "delete"], id(name), "--json");

        timing("checkpoint delete", started);
        expect(deleted.code, deleted.stdout).toBe(0);
      }

      expect(await snapshots()).toEqual([]);
      expect(decode(Checkpoints, await cli(["checkpoint", "list"], "--json")).checkpoints).toEqual(
        [],
      );
      await removeMachine("fork-b");
      await removeMachine("restore-a");
      expect((await machines()).machines).toEqual([]);
    },
    minutes(5),
  );

  test(
    "after the host is killed during a create's setup, the row reads failed; stop stops the sandbox, start, fork and capture refuse it as never made, writing nothing, and delete removes it",
    async () => {
      let ended: Ran | undefined;

      const creating = counted("create", "crash", () =>
        createWith(
          "crash",
          "#!/bin/sh\ntouch /var/tmp/clankerbox-live-setup-started\nsleep 600\n",
          900,
        ),
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
        900,
        3000,
      );
      expect((await control("host-kill")).code).toBe(0);

      const lost = failure(await creating);

      expect(lost.tag).toBe("Unavailable");
      expect(lost.message).toContain("may have run");
      expect((await control("host-start")).code).toBe(0);
      expect(await machine("crash")).toMatchObject({
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
      expect(await natives("crash")).toEqual({
        sandboxes: [{ id: expect.any(String), state: "archived" }],
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
      expect(await natives("crash-fork")).toEqual(boat.nothing);
      expect(await snapshots()).toEqual([]);
      expect(decode(Checkpoints, await cli(["checkpoint", "list"], "--json")).checkpoints).toEqual(
        [],
      );

      const started = performance.now();

      await removeMachine("crash");
      timing("delete (never made, stopped)", started);
      expect((await machines()).machines).toEqual([]);
    },
    minutes(30),
  );
});

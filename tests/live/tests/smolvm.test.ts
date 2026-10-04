/**
 * Phase 3's live acceptance on a smolvm host, through the CLI: lifecycle, setup and
 * preparation, guest access, claims, the RAM budget, crashes and restarts. The tests run in
 * order and share one machine, `main`, whose setup installs sshd and the run's own key; every
 * other machine is deleted by the test that made it. Timings print as `[timing]` lines.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Machine, version } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type Environment,
  environment,
  Failure,
  Hosts,
  Machines,
  namePrefix,
  Natives,
  OneMachine,
  type Ran,
  run,
  scratch,
  writeFileIn,
} from "./live.ts";

const live = process.env["CLANKERBOX_LIVE"] === "1";

const minutes = (count: number) => count * 60_000;

/** The setup of `main`: sshd, rsync and the run's key, a `start` and a `new-identity` hook. */
const mainSetup = (publicKey: string) => `#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server rsync >/dev/null
install -d -m 700 /root/.ssh
printf '%s\\n' '${publicKey}' >/root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
install -d /etc/clankerbox /var/lib/clankerbox-live
cp files/payload.bin /root/payload.bin
cat >/etc/clankerbox/start <<'START'
#!/bin/sh
set -eu
echo start >>/var/lib/clankerbox-live/starts
if [ -e /root/fail-start ]; then
  echo "start refused: /root/fail-start exists"
  exit 4
fi
mkdir -p /run/sshd
pid=$(cat /run/sshd.pid 2>/dev/null || true)
if [ -z "$pid" ] || [ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" != sshd ]; then
  /usr/sbin/sshd
fi
START
cat >/etc/clankerbox/new-identity <<'IDENTITY'
#!/bin/sh
echo identity >>/var/lib/clankerbox-live/identities
IDENTITY
chmod 755 /etc/clankerbox/start /etc/clankerbox/new-identity
echo setup >>/var/lib/clankerbox-live/setups
# sshd runs before preparation, so its re-mint has a running sshd to SIGHUP.
mkdir -p /run/sshd
/usr/sbin/sshd
cp /run/sshd.pid /var/lib/clankerbox-live/setup-sshd-pid
`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const timing = (label: string, started: number) => {
  console.log(`[timing] ${label} ${((performance.now() - started) / 1000).toFixed(2)}s`);
};

const decode = <A>(schema: Schema.Codec<A, string>, ran: Ran): A => {
  try {
    return Schema.decodeUnknownSync(schema)(ran.stdout);
  } catch (error) {
    throw new Error(`couldn't decode (exit ${ran.code}): ${ran.stdout}\n${ran.stderr}`, {
      cause: error,
    });
  }
};

describe.skipIf(!live)("a smolvm host, through the CLI", () => {
  let env: Environment;
  let dir: string;
  let key: string;
  let recipe: string;
  let payload: Uint8Array;

  const cli = (command: ReadonlyArray<string>, ...args: ReadonlyArray<string>) =>
    run(env.binary, [...command, "--config", env.config, ...args]);

  const id = (name: string) => `${env.host.id}_${namePrefix}${name}`;

  const control = (...args: ReadonlyArray<string>) => run(env.control, args);

  const machines = async () => decode(Machines, await cli(["machines"], "--json"));

  const machine = async (name: string): Promise<Machine | undefined> =>
    (await machines()).machines.find((listed) => listed.id === id(name));

  const sizes = (ramMib: number) => [
    "--base",
    "ubuntu",
    "--cpu",
    "1",
    "--ram-mib",
    String(ramMib),
    "--disk-gib",
    "20",
  ];

  /** Creates `name` with no setup. */
  const createBare = (name: string, ramMib = 512) =>
    cli(["create"], id(name), ...sizes(ramMib), "--json");

  /** Creates `name` with `script` as its setup file. */
  const createWith = async (name: string, script: string, timeoutSeconds: number) => {
    const file = await writeFileIn(dir, `${name}-setup.sh`, script, 0o755);

    return cli(
      ["create"],
      id(name),
      ...sizes(512),
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
      "root",
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

  const natives = async (name: string) => {
    const ran = await control("natives", `${namePrefix}${name}-`);

    expect(ran.code, ran.stderr).toBe(0);

    return decode(Natives, ran);
  };

  const removeMachine = async (name: string) => {
    const ran = await cli(["delete"], id(name), "--json");

    expect(ran.code, ran.stdout).toBe(0);
    expect(await natives(name)).toEqual({ machines: [], scopes: [] });
  };

  const waitFor = async (what: string, check: () => Promise<boolean>, seconds: number) => {
    const deadline = performance.now() + seconds * 1000;

    while (!(await check())) {
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const count = async (name: string, file: string) =>
    (await inGuest(name, `cat /var/lib/clankerbox-live/${file}`)).split("\n").length;

  beforeAll(async () => {
    env = await environment();
    dir = await scratch();
    key = join(dir, "key");

    const keygen = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);

    expect(keygen.code, keygen.stderr).toBe(0);

    const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();

    recipe = join(dir, "recipe");
    payload = randomBytes(64 * 1024);
    await mkdir(join(recipe, "files"), { recursive: true });
    await writeFileIn(recipe, "setup.sh", mainSetup(publicKey), 0o755);
    await writeFileIn(join(recipe, "files"), "payload.bin", payload);
  });

  afterAll(async () => {
    const listed = await machines();

    for (const left of listed.machines.filter(({ id: listedId }) =>
      listedId.startsWith(`${env.host.id}_${namePrefix}`),
    )) {
      await cli(["delete"], left.id);
    }

    // It holds the run's private key and its setup scripts.
    await rm(dir, { recursive: true, force: true });
  }, minutes(5));

  test("hosts names the host under test with its runtime, versions and bases, and the host that is down", async () => {
    const { hosts, unreachable } = decode(Hosts, await cli(["hosts"], "--json"));

    expect(hosts).toEqual([
      {
        id: env.host.id,
        runtime: "smolvm",
        version,
        runtimeVersion: "1.22.2",
        bases: ["ubuntu"],
      },
    ]);
    expect(unreachable.map(({ host, error }) => [host, error.tag])).toEqual(
      env.down.map(({ id: downId }) => [downId, "Unavailable"]),
    );
  });

  test(
    "create packs the recipe, runs its setup once and then preparation, and reports the endpoint and key",
    async () => {
      const started = performance.now();

      const ran = await cli(
        ["create"],
        id("main"),
        ...sizes(1024),
        "--setup",
        recipe,
        "--setup-timeout",
        "600",
        "--json",
      );

      timing("create with setup (apt-get openssh-server rsync)", started);
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

      // clankerbox ssh pins Machine.hostKey: logging in proves sshd serves it. setup started
      // sshd before preparation re-minted the keys, and its pid is unchanged, so the SIGHUP
      // made it re-execute with the new key rather than a relaunch.
      const facts = await inGuest(
        "main",
        [
          "cat /var/lib/clankerbox/machine-id /var/lib/clankerbox/instance",
          "cat /run/sshd.pid /var/lib/clankerbox-live/setup-sshd-pid",
          "sha256sum /root/payload.bin | cut -d ' ' -f 1",
          "ls -A /var/tmp | grep -c clankerbox-setup || true",
        ].join("; "),
      );

      const [machineId, instance, sshdPid, setupSshdPid, payloadSum, setupFiles] =
        facts.split("\n");

      expect(machineId).toBe(id("main"));
      expect(instance).toMatch(/^[0-9a-f]{32}$/u);
      expect(sshdPid).toBe(setupSshdPid);
      expect(payloadSum).toBe(sha256(payload));
      expect(setupFiles).toBe("0");
      expect(await count("main", "setups")).toBe(1);
      expect(await count("main", "identities")).toBe(1);
      expect(await count("main", "starts")).toBe(1);
    },
    minutes(10),
  );

  test("machines lists the machine with its age, and names the host that is down", async () => {
    const text = await cli(["machines"]);
    const row = text.stdout.split("\n").find((line) => line.startsWith(id("main")));

    expect(text.code).toBe(0);
    expect(text.stdout.split("\n")[0]).toContain("AGE");
    expect(row?.split(/\s+/u)).toContain("running");
    expect(row).toMatch(/\s\d+[smhd]\s/u);

    for (const { id: downId } of env.down) {
      expect(text.stderr).toContain(`Unavailable: host ${downId}`);
    }
  });

  test(
    "scp and rsync move a binary file both ways, pinned to the machine's host key",
    async () => {
      const target = await machine("main");
      const endpoint = target?.ssh;

      expect(endpoint).toBeDefined();

      if (target === undefined || endpoint === undefined) {
        return;
      }

      const options = await pinned(target);
      const local = await writeFileIn(dir, "upload.bin", randomBytes(256 * 1024));
      const remote = `root@${endpoint.host}`;

      const up = await run("scp", [
        ...options,
        "-P",
        String(endpoint.port),
        local,
        `${remote}:/root/up.bin`,
      ]);

      const down = join(dir, "scp-down.bin");

      const back = await run("scp", [
        ...options,
        "-P",
        String(endpoint.port),
        `${remote}:/root/up.bin`,
        down,
      ]);

      const rsh = ["ssh", ...options, "-p", String(endpoint.port)].join(" ");
      const synced = join(dir, "rsync-down.bin");
      const rsyncUp = await run("rsync", ["-a", "-e", rsh, local, `${remote}:/root/rsync-up.bin`]);

      const rsyncDown = await run("rsync", [
        "-a",
        "-e",
        rsh,
        `${remote}:/root/rsync-up.bin`,
        synced,
      ]);

      const expected = sha256(await readFile(local));

      for (const ran of [up, back, rsyncUp, rsyncDown]) {
        expect(ran.code, ran.stderr).toBe(0);
      }

      expect(sha256(await readFile(down))).toBe(expected);
      expect(sha256(await readFile(synced))).toBe(expected);
      expect(
        await inGuest("main", "sha256sum /root/up.bin /root/rsync-up.bin | cut -d ' ' -f 1"),
      ).toBe(`${expected}\n${expected}`);
    },
    minutes(5),
  );

  test(
    "stop and a cold start keep the machine's files and key; start runs again, setup and new-identity don't",
    async () => {
      const before = await machine("main");
      let started = performance.now();
      const stopped = await cli(["stop"], id("main"), "--json");

      timing("stop", started);
      expect(stopped.code, stopped.stdout).toBe(0);
      expect(decode(OneMachine, stopped)).toMatchObject({
        state: "stopped",
        action: { name: "stop", status: "done" },
      });

      const again = await cli(["stop"], id("main"), "--json");

      expect(decode(OneMachine, again).action).toEqual({ name: "stop", status: "done" });

      started = performance.now();

      const coldStart = await cli(["start"], id("main"), "--json");

      timing("start (cold, with preparation)", started);
      expect(coldStart.code, coldStart.stdout).toBe(0);

      const after = decode(OneMachine, coldStart);

      expect(after).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
      expect(after.hostKey).toBe(before?.hostKey);
      expect(after.ssh).toEqual(before?.ssh);
      expect(await inGuest("main", "cat /var/lib/clankerbox/machine-id")).toBe(id("main"));
      expect(await count("main", "setups")).toBe(1);
      expect(await count("main", "identities")).toBe(1);
      expect(await count("main", "starts")).toBe(2);
    },
    minutes(5),
  );

  test(
    "start on a running machine runs preparation again, which relaunches a killed sshd",
    async () => {
      await ssh("main", "kill $(cat /run/sshd.pid)");
      expect((await ssh("main", "true")).code).not.toBe(0);

      const started = performance.now();
      const repaired = await cli(["start"], id("main"), "--json");

      timing("start (running machine: preparation only)", started);
      expect(repaired.code, repaired.stdout).toBe(0);
      expect(await count("main", "starts")).toBe(3);
      expect(await count("main", "identities")).toBe(1);
    },
    minutes(3),
  );

  test(
    "a failing start fails the action with its output, and the next start succeeds",
    async () => {
      await inGuest("main", "touch /root/fail-start");

      const error = failure(await cli(["start"], id("main"), "--json"));
      const failed = await machine("main");

      expect(error.tag).toBe("Precondition");
      expect(error.message).toContain("start refused: /root/fail-start exists");
      expect(failed?.action).toMatchObject({ name: "start", status: "failed" });

      await inGuest("main", "rm /root/fail-start");

      const repaired = await cli(["start"], id("main"), "--json");

      expect(repaired.code, repaired.stdout).toBe(0);
      expect(decode(OneMachine, repaired).action).toEqual({ name: "start", status: "done" });
    },
    minutes(3),
  );

  test(
    "a re-mint under a running sshd makes it serve the new key, which becomes Machine.hostKey",
    async () => {
      const before = await machine("main");
      const sshdPid = await inGuest("main", "rm /var/lib/clankerbox/instance; cat /run/sshd.pid");
      const reminted = decode(OneMachine, await cli(["start"], id("main"), "--json"));

      expect(reminted.hostKey).toBeDefined();
      expect(reminted.hostKey).not.toBe(before?.hostKey);
      // clankerbox ssh pins the new key; the listener kept its pid, so SIGHUP reloaded it.
      expect(await inGuest("main", "cat /run/sshd.pid")).toBe(sshdPid);
      expect(await count("main", "identities")).toBe(2);

      if (before?.ssh === undefined) {
        throw new Error("main has no endpoint");
      }

      const stale = await run("ssh", [
        ...(await pinned(before)),
        "-p",
        String(before.ssh.port),
        `root@${before.ssh.host}`,
        "true",
      ]);

      expect(stale.code).toBe(255);
      expect(stale.stderr).toMatch(/host key|HOST IDENTIFICATION/iu);
    },
    minutes(3),
  );

  test("a guest can't reach its own host's API port on the tailnet address", async () => {
    const api = new URL(env.host.url);

    const probe = (address: string, port: string) =>
      `timeout 5 bash -c 'echo >/dev/tcp/${address}/${port}' 2>/dev/null && echo reached || echo refused`;

    expect(await inGuest("main", probe(api.hostname, api.port))).toBe("refused");
    // The same probe reaches the internet, so the refusal is the host's address.
    expect(await inGuest("main", probe("1.1.1.1", "443"))).toBe("reached");
  });

  test(
    "a taken name is Conflict{exists}, and an action on a claimed machine is Conflict{busy}",
    async () => {
      const creating = createWith("busy", "#!/bin/sh\necho waiting\nsleep 20\n", 120);

      await waitFor(
        "busy's create to hold its row",
        async () => (await machine("busy"))?.action.status === "running",
        60,
      );

      const busy = failure(await cli(["delete"], id("busy"), "--json"));
      const exists = failure(await createBare("busy"));

      expect(busy).toMatchObject({ tag: "Conflict", retryable: true });
      expect(exists).toMatchObject({ tag: "Conflict", retryable: false });
      expect(exists.message).toContain("exists");
      expect((await creating).code).toBe(0);
      await removeMachine("busy");
    },
    minutes(5),
  );

  test(
    "a failing setup fails the create with its output, and the row stays failed until delete",
    async () => {
      const error = failure(
        await createWith(
          "failing",
          "#!/bin/sh\necho installing\necho no network >&2\nexit 7\n",
          60,
        ),
      );

      expect(error.tag).toBe("Precondition");
      expect(error.message).toContain("setup exited 7");
      expect(error.message).toContain("installing\nno network");
      expect((await machine("failing"))?.action).toMatchObject({
        name: "create",
        status: "failed",
        error: { tag: "Precondition" },
      });
      await removeMachine("failing");
    },
    minutes(5),
  );

  test(
    "a setup past its timeout fails the create with its output; its command ends and its file goes",
    async () => {
      const error = failure(
        await createWith("overrun", "#!/bin/sh\necho overrun-started\nsleep 600\n", 5),
      );

      expect(error.tag).toBe("Precondition");
      expect(error.message).toContain("setup ran past its 5s timeout");
      expect(error.message).toContain("overrun-started");

      // The guard that removes the file polls once a second.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const seen = await control("guest", `${namePrefix}overrun`, "ps -eo args; ls -A /var/tmp");

      expect(seen.code, seen.stderr).toBe(0);
      expect(seen.stdout).not.toContain("sleep 600");
      expect(seen.stdout).not.toContain("clankerbox-setup.");
      await removeMachine("overrun");
    },
    minutes(5),
  );

  test(
    "a failing new-identity hook fails the create with its output",
    async () => {
      const error = failure(
        await createWith(
          "hook",
          [
            "#!/bin/sh",
            "mkdir -p /etc/clankerbox",
            "printf '#!/bin/sh\\necho hook refused\\nexit 3\\n' >/etc/clankerbox/new-identity",
            "chmod 755 /etc/clankerbox/new-identity",
            "",
          ].join("\n"),
          60,
        ),
      );

      expect(error.tag).toBe("Precondition");
      expect(error.message).toContain("preparation exited 3");
      expect(error.message).toContain("hook refused");
      await removeMachine("hook");
    },
    minutes(5),
  );

  test(
    "the RAM budget refuses with Capacity, writing nothing, even for two concurrent creates that each fit alone",
    async () => {
      const huge = failure(await createBare("huge", 1_048_576));

      expect(huge.tag).toBe("Capacity");
      expect(await machine("huge")).toBeUndefined();

      const budget = Number(/budget of (\d+) MiB/u.exec(huge.message)?.[1]);

      const running = (await machines()).machines
        .filter(({ state }) => state === "running")
        .reduce((sum, { ramMib }) => sum + ramMib, 0);

      const each = budget - running;

      expect(each).toBeGreaterThanOrEqual(512);

      const results = await Promise.all([createBare("ram-a", each), createBare("ram-b", each)]);
      const passed = results.filter(({ code }) => code === 0);

      expect(passed.length).toBeLessThan(2);

      for (const refused of results.filter(({ code }) => code !== 0)) {
        expect(failure(refused).tag).toBe("Capacity");
      }

      for (const name of ["ram-a", "ram-b"]) {
        const row = await machine(name);

        if (row !== undefined) {
          expect(row.action).toEqual({ name: "create", status: "done" });
          await removeMachine(name);
        }
      }

      expect((await machines()).machines.map(({ id: listedId }) => listedId)).toEqual([id("main")]);
    },
    minutes(5),
  );

  test(
    "a host restart keeps running machines, their published ports and machine IDs",
    async () => {
      const before = await machine("main");
      const uptime = Number((await inGuest("main", "cut -d ' ' -f 1 /proc/uptime")).trim());

      expect((await control("host-stop")).code).toBe(0);
      expect((await control("host-start")).code).toBe(0);

      const after = await machine("main");

      expect(after?.state).toBe("running");
      expect(after?.ssh).toEqual(before?.ssh);
      expect(after?.hostKey).toBe(before?.hostKey);
      expect(await inGuest("main", "cat /var/lib/clankerbox/machine-id")).toBe(id("main"));
      expect(
        Number((await inGuest("main", "cut -d ' ' -f 1 /proc/uptime")).trim()),
      ).toBeGreaterThan(uptime);
    },
    minutes(5),
  );

  test(
    "after the host is killed during a create's setup, the row reads failed, stop stops the VM and delete removes it",
    async () => {
      let ended: Ran | undefined;

      const creating = createWith(
        "crash",
        "#!/bin/sh\ntouch /root/setup-started\nsleep 300\n",
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
            (await control("guest", `${namePrefix}crash`, "test -e /root/setup-started")).code === 0
          );
        },
        180,
      );
      expect((await control("host-kill")).code).toBe(0);

      const lost = failure(await creating);

      expect(lost.tag).toBe("Unavailable");
      expect(lost.message).toContain("may have run");
      expect((await control("host-start")).code).toBe(0);

      const row = await machine("crash");

      expect(row).toMatchObject({
        state: "running",
        action: {
          name: "create",
          status: "failed",
          error: { tag: "Internal", message: "host restarted during create" },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const seen = await control("guest", `${namePrefix}crash`, "ps -eo args; ls -A /var/tmp");

      expect(seen.stdout).not.toContain("sleep 300");
      expect(seen.stdout).not.toContain("clankerbox-setup.");

      const stopped = await cli(["stop"], id("crash"), "--json");

      expect(stopped.code, stopped.stdout).toBe(0);
      expect(decode(OneMachine, stopped)).toMatchObject({
        state: "stopped",
        action: { name: "stop", status: "done" },
      });
      expect(await natives("crash")).toMatchObject({
        machines: [{ state: "stopped" }],
        scopes: [],
      });
      await removeMachine("crash");
    },
    minutes(10),
  );

  test(
    "a native machine that already carries a machine's name is left alone by that machine's create and delete",
    async () => {
      const decoy = await control("decoy", `${namePrefix}decoy`);

      expect(decoy.code, decoy.stderr).toBe(0);

      const created = await createBare("decoy");

      expect(created.code, created.stdout).toBe(0);
      expect((await natives("decoy")).machines).toHaveLength(2);

      const removed = await cli(["delete"], id("decoy"), "--json");

      expect(removed.code, removed.stdout).toBe(0);
      expect((await natives("decoy")).machines).toEqual([{ name: decoy.stdout, state: "running" }]);
      expect((await control("remove-native", decoy.stdout)).code).toBe(0);
      expect(await natives("decoy")).toEqual({ machines: [], scopes: [] });
    },
    minutes(5),
  );

  test(
    "a stop the guest won't confirm fails the action, and delete still removes the VM and its scope",
    async () => {
      const created = await createBare("stuck");

      expect(created.code, created.stdout).toBe(0);
      expect((await control("freeze", `${namePrefix}stuck`)).code).toBe(0);

      const error = failure(await cli(["stop"], id("stuck"), "--json"));
      const row = await machine("stuck");

      expect(error.tag).toBe("Internal");
      expect(error.message).toContain("did not confirm filesystem synchronization");
      expect(error.message).not.toContain("\u001b[");
      expect(row).toMatchObject({ state: "running", action: { name: "stop", status: "failed" } });

      const started = performance.now();

      await removeMachine("stuck");
      timing("delete after a failed stop (SIGKILL of the scope)", started);
    },
    minutes(5),
  );

  test("--json errors carry their tags", async () => {
    const notFound = failure(await cli(["start"], id("nope"), "--json"));
    const invalid = failure(await createBare("bad--name"));

    const precondition = failure(
      await cli(
        ["create"],
        id("nobase"),
        "--base",
        "nope",
        "--cpu",
        "1",
        "--ram-mib",
        "512",
        "--disk-gib",
        "20",
        "--json",
      ),
    );

    const placed = failure(
      await cli(
        ["create"],
        `${namePrefix}nobase`,
        "--base",
        "nope",
        "--cpu",
        "1",
        "--ram-mib",
        "512",
        "--disk-gib",
        "20",
        "--json",
      ),
    );

    const unavailable = failure(
      await cli(["start"], `${env.down[0]?.id ?? ""}_${namePrefix}x`, "--json"),
    );

    expect(notFound.tag).toBe("NotFound");
    expect(invalid.tag).toBe("Invalid");
    expect(precondition.tag).toBe("Precondition");
    expect(precondition.message).toContain("ubuntu");
    expect(placed.tag).toBe("Unavailable");
    expect(unavailable).toMatchObject({ tag: "Unavailable", retryable: false });
  });

  test(
    "delete removes the machine, its VM and its scope",
    async () => {
      const started = performance.now();

      await removeMachine("main");
      timing("delete (running machine)", started);
      expect(await machine("main")).toBeUndefined();
    },
    minutes(3),
  );
});

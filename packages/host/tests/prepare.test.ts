/**
 * The preparation script itself, run with the host's `/bin/sh` against a temporary guest root,
 * with `perl`, `ssh-keygen` and `uname` stubbed. Nothing here prints the script.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { hostKeyIn, preparationScript } from "../src/guest.ts";
import { writeStubs } from "./fake-runtime.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

const children: Array<() => void> = [];

afterEach(async () => {
  for (const kill of children.splice(0)) {
    kill();
  }

  await removeScratch(owned);
});

/** A guest root with its `dev` and the stubs, under a fresh scratch directory. */
const guest = async (uname = "Linux") => {
  const dir = await scratch(owned);
  const root = join(dir, "root");

  await mkdir(join(root, "dev"), { recursive: true });

  return { root, bin: writeStubs(dir, uname) };
};

const prepare = (
  where: { readonly root: string; readonly bin: string },
  instance: string,
  seed: Uint8Array = randomBytes(64),
  path = `${where.bin}:${process.env["PATH"]}`,
) => {
  const ran = spawnSync("/bin/sh", ["-c", preparationScript, "prepare", instance, "linux_dev"], {
    env: { ...process.env, CLANKERBOX_ROOT: where.root, PATH: path },
    input: seed,
    encoding: "utf8",
  });

  return { code: ran.status, output: `${ran.stdout}${ran.stderr}` };
};

const read = (root: string, file: string) => readFile(join(root, file), "utf8");

const calls = async (root: string) =>
  (await read(root, "calls").catch(() => "")).split("\n").filter((line) => line !== "");

/** Installs an executable hook under the guest's `/etc/clankerbox`. */
const hook = async (root: string, name: string, body: string) => {
  const file = join(root, "etc", "clankerbox", name);

  await mkdir(join(root, "etc", "clankerbox"), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
};

const withHostKeys = async (root: string) => {
  await mkdir(join(root, "etc", "ssh"), { recursive: true });
  await writeFile(join(root, "etc", "ssh", "ssh_host_ed25519_key"), "old private\n");
  await writeFile(
    join(root, "etc", "ssh", "ssh_host_ed25519_key.pub"),
    "ssh-ed25519 AAAAold root@old\n",
  );
};

test("a new instance reseeds, writes the machine ID and the instance, and runs start", async () => {
  const where = await guest();
  const seed = randomBytes(64);

  await hook(
    where.root,
    "start",
    `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id" >"$CLANKERBOX_ROOT/started"`,
  );

  const { code, output } = prepare(where, "aaaa1111", seed);

  expect(code, output).toBe(0);
  expect(await readFile(join(where.root, "dev", "random"))).toEqual(seed);
  expect(await calls(where.root)).toEqual([`perl ${where.root}/dev/urandom`]);
  expect(await read(where.root, "var/lib/clankerbox/machine-id")).toBe("linux_dev\n");
  expect(await read(where.root, "var/lib/clankerbox/instance")).toBe("aaaa1111\n");
  expect(await read(where.root, "started")).toBe("linux_dev\n");
  expect(hostKeyIn(output)).toBeUndefined();
});

test("on Linux without perl, preparation says it needs perl", async () => {
  const where = await guest();

  // Only the stubs and `cat` are on PATH, and the script adds only the guest root's own dirs.
  await rm(join(where.bin, "perl"));
  await symlink("/bin/cat", join(where.bin, "cat"));

  const { code, output } = prepare(where, "aaaa1111", randomBytes(64), where.bin);

  expect(code).toBe(1);
  expect(output).toContain("preparation needs perl");
  await expect(stat(join(where.root, "var/lib/clankerbox/instance"))).rejects.toThrow();
});

test("on macOS the seed write is the whole reseed", async () => {
  const where = await guest("Darwin");
  const { code, output } = prepare(where, "aaaa1111");

  expect(code, output).toBe(0);
  expect((await stat(join(where.root, "dev", "random"))).size).toBe(64);
  expect(await calls(where.root)).toEqual([]);
});

test("host keys are re-minted after the reseed, and the new public key is printed last", async () => {
  const where = await guest();

  await withHostKeys(where.root);

  const { code, output } = prepare(where, "aaaa1111");
  const printed = hostKeyIn(output);

  expect(code, output).toBe(0);
  expect(await calls(where.root)).toEqual([`perl ${where.root}/dev/urandom`, "ssh-keygen -A"]);
  expect(printed).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
  expect(`${printed} root@stub\n`).toBe(await read(where.root, "etc/ssh/ssh_host_ed25519_key.pub"));
});

test("the same instance skips identity, but start runs and the key is printed again", async () => {
  const where = await guest();

  await withHostKeys(where.root);
  await hook(where.root, "new-identity", `echo hook >>"$CLANKERBOX_ROOT/hooks"`);
  await hook(where.root, "start", `echo start >>"$CLANKERBOX_ROOT/starts"`);

  const first = prepare(where, "aaaa1111");
  const callsAfterFirst = await calls(where.root);
  const second = prepare(where, "aaaa1111");

  expect(first.code).toBe(0);
  expect(second.code, second.output).toBe(0);
  expect(await calls(where.root)).toEqual(callsAfterFirst);
  expect(await read(where.root, "hooks")).toBe("hook\n");
  expect(await read(where.root, "starts")).toBe("start\nstart\n");
  expect(hostKeyIn(second.output)).toBe(hostKeyIn(first.output));
});

test("another instance, as after a fork or a restore under a reused name, re-mints again", async () => {
  const where = await guest();

  await withHostKeys(where.root);

  const first = prepare(where, "aaaa1111");
  const second = prepare(where, "bbbb2222");

  expect(second.code, second.output).toBe(0);
  expect(hostKeyIn(second.output)).not.toBe(hostKeyIn(first.output));
  expect(await read(where.root, "var/lib/clankerbox/instance")).toBe("bbbb2222\n");
});

test("new-identity sees the new machine ID; when it fails, the instance stays old so it runs again", async () => {
  const where = await guest();

  await hook(
    where.root,
    "new-identity",
    `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id"; echo "hook broke" >&2; exit 4`,
  );

  const { code, output } = prepare(where, "aaaa1111");

  expect(code).toBe(4);
  expect(output).toContain("linux_dev");
  expect(output).toContain("hook broke");
  await expect(stat(join(where.root, "var/lib/clankerbox/instance"))).rejects.toThrow();
});

test("a failing start fails preparation with its output", async () => {
  const where = await guest();

  await hook(where.root, "start", `echo "sshd wouldn't start"; exit 2`);

  const { code, output } = prepare(where, "aaaa1111");

  expect(code).toBe(2);
  expect(output).toContain("sshd wouldn't start");
});

/** Waits until `file` holds `text`; the test's timeout bounds the wait. */
const waitFor = async (file: string, text: string) => {
  while (!(await readFile(file, "utf8").catch(() => "")).includes(text)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * A process standing in for sshd's listener, which records the SIGHUP that makes it re-exec.
 * It writes `ready` once its traps are in, and `usr1` on SIGUSR1, which `settled` sends: the
 * shell runs pending traps in signal order, so a SIGHUP sent before it is recorded first.
 */
const listener = async (root: string, comm: string) => {
  const marker = join(root, "listener");

  const child = spawn(
    "/bin/sh",
    [
      "-c",
      [
        `trap 'echo hup >>"${marker}"' HUP`,
        `trap 'echo usr1 >>"${marker}"' USR1`,
        `echo ready >>"${marker}"`,
        "while :; do sleep 0.05; done",
      ].join("\n"),
    ],
    { stdio: "ignore" },
  );

  children.push(() => child.kill("SIGKILL"));

  const pid = child.pid ?? 0;

  await mkdir(join(root, "run"), { recursive: true });
  await mkdir(join(root, "proc", `${pid}`), { recursive: true });
  await writeFile(join(root, "run", "sshd.pid"), `${pid}\n`);
  await writeFile(join(root, "proc", `${pid}`, "comm"), `${comm}\n`);
  await waitFor(marker, "ready");

  return {
    hup: () => waitFor(marker, "hup"),
    /** What the listener recorded by the time it handled a SIGUSR1 sent now. */
    settled: async () => {
      child.kill("SIGUSR1");
      await waitFor(marker, "usr1");

      return readFile(marker, "utf8");
    },
  };
};

test("a running sshd gets SIGHUP after the re-mint, so it serves the new key", async () => {
  const where = await guest();

  await withHostKeys(where.root);

  const sshd = await listener(where.root, "sshd");
  const { code, output } = prepare(where, "aaaa1111");

  expect(code, output).toBe(0);
  await sshd.hup();
});

test("a stale sshd.pid naming another process is left alone", async () => {
  const where = await guest();
  const other = await listener(where.root, "sleep");
  const { code, output } = prepare(where, "aaaa1111");

  expect(code, output).toBe(0);
  expect(await other.settled()).not.toContain("hup");
});

test("hostKeyIn takes the last marker line and refuses anything that isn't a key", () => {
  expect(
    hostKeyIn(
      "clankerbox-host-key: ssh-rsa AAAAold\nlog\nclankerbox-host-key: ssh-ed25519 AAAAnew=\n",
    ),
  ).toBe("ssh-ed25519 AAAAnew=");
  expect(hostKeyIn("clankerbox-host-key: not a key\n")).toBeUndefined();
  expect(hostKeyIn("no key here\n")).toBeUndefined();
});

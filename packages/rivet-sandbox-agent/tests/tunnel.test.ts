import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Internal, WrongState } from "@gjermundgaraba/clankerbox-sdk";
import { machine } from "@gjermundgaraba/clankerbox-sdk/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { LocalTunnelError } from "../src/tunnel.ts";
import {
  cleanUp,
  cleanups,
  fakeSsh,
  gone,
  hostKey,
  listening,
  login,
  reachable,
  setup,
  until,
} from "./support.ts";

afterEach(cleanUp);

test("ensureServer opens a tunnel that ended on the same port, and starts the machine only when its agent doesn't answer", async () => {
  const { dir, stub, sandbox, calls } = await setup({ machines: [reachable("linux_kept")] });
  const opened = await sandbox.getUrl("linux_kept");
  const [first] = await calls();

  process.kill(first?.pid ?? 0);
  await until(
    "the tunnel to end",
    async () => gone(first?.pid ?? 0) && !(await listening(first?.port ?? 0)),
  );
  stub.calls.length = 0;

  await sandbox.ensureServer("linux_kept");

  const [, second] = await calls();

  expect(second?.port).toBe(first?.port);
  expect(await sandbox.getUrl("linux_kept")).toBe(opened);
  expect(stub.calls).toEqual(["machine.get"]);

  await writeFile(join(dir, "unhealthy"), "");
  stub.hold(reachable("linux_kept", { ssh: { ...login, port: 20_022 } }));
  stub.calls.length = 0;

  await sandbox.ensureServer("linux_kept");

  const [, , third] = await calls();

  expect(stub.calls).toEqual(["machine.start", "machine.get"]);
  expect(third?.port).toBe(first?.port);
  expect(third?.args).toContain("Port=20022");
});

test("a tunnel whose ssh fails says what ssh printed or why it couldn't run, and a machine without an endpoint is WrongState", async () => {
  const { dir, sandbox } = await setup({
    machines: [reachable("linux_kept"), machine("linux_stopped", { state: "stopped", hostKey })],
  });

  await writeFile(join(dir, "refuse"), "");

  await expect(sandbox.getUrl("linux_kept")).rejects.toEqual(
    new Internal({
      message:
        "the tunnel to linux_kept ended before it listened: admin@100.64.0.7: Permission denied (publickey).",
    }),
  );

  const unrun = await setup({ machines: [reachable("linux_kept")] }, {}, "/nonexistent/ssh");

  await expect(unrun.sandbox.getUrl("linux_kept")).rejects.toEqual(
    new LocalTunnelError({
      message:
        "the tunnel to linux_kept ended before it listened: couldn't run /nonexistent/ssh: spawn /nonexistent/ssh ENOENT",
    }),
  );

  await expect(sandbox.getUrl("linux_stopped")).rejects.toEqual(
    new WrongState({
      message:
        "linux_stopped has no SSH endpoint (stopped, createMachine done): see clankerbox get linux_stopped",
      machine: "linux_stopped",
      state: "stopped",
    }),
  );
});

test("a tunnel refuses a port another program took while it was down, and ensureServer doesn't start the machine for it", async () => {
  const { stub, sandbox, calls } = await setup({ machines: [reachable("linux_kept")] });

  await sandbox.getUrl("linux_kept");

  const [first] = await calls();
  const port = first?.port ?? 0;

  process.kill(first?.pid ?? 0);
  await until("the tunnel to end", async () => gone(first?.pid ?? 0) && !(await listening(port)));

  const squatter = createServer().listen(port, "127.0.0.1");

  cleanups.push(() => new Promise((resolve) => squatter.close(() => resolve())));
  await once(squatter, "listening");
  stub.calls.length = 0;

  await expect(sandbox.ensureServer("linux_kept")).rejects.toEqual(
    new LocalTunnelError({
      message: `the tunnel to linux_kept can't use port ${port}: another program listens on it`,
    }),
  );
  expect(await calls()).toHaveLength(1);
  expect(stub.calls).toEqual(["machine.get"]);
});

test("a tunnel left open doesn't keep its program running, and ends when the program does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-provider-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env["FAKE_SSH_DIR"] = dir;

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("leave-tunnel.ts", import.meta.url)), fakeSsh, dir],
    { timeout: 10_000 },
  );

  const port = Number(stdout);

  expect(port).toBeGreaterThan(0);
  await until("the tunnel to end", async () => !(await listening(port)));
});

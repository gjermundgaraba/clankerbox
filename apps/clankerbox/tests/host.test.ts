/** The CLI against a real host, served on loopback over the fake runtime. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { ErrorTag } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { type ServedHost, serveHost } from "../../../packages/host/tests/support.ts";
import { cleanup, cli, scratch } from "./support.ts";

const owned: Array<string> = [];

const served: Array<ServedHost> = [];

afterEach(async () => {
  await Promise.all(served.splice(0).map(({ dispose }) => dispose()));
  await cleanup(owned, []);
});

/** A host `linux` and a client config that lists it, by its real loopback URL. */
const setUp = async () => {
  const dir = await scratch(owned);
  const host = await serveHost(dir);
  const config = join(dir, "config.json");

  served.push(host);
  await writeFile(config, JSON.stringify({ hosts: [{ id: "linux", url: host.url }] }));

  const run = (args: ReadonlyArray<string>) =>
    cli([...args, "--config", config], { http: NodeHttpClient.layerNodeHttp });

  return { host, run, dir };
};

const sizes = ["--base", "ubuntu", "--cpu", "1", "--ram-mib", "1024", "--disk-gib", "10"];

test("create, stop, start and delete run on the host, and the CLI prints each outcome", async () => {
  const { host, run } = await setUp();

  const created = await run(["create", "dev", ...sizes]);
  const stopped = await run(["stop", "linux_dev"]);
  const started = await run(["start", "linux_dev"]);
  const listed = await run(["machines"]);
  const removed = await run(["delete", "linux_dev"]);
  const again = await run(["delete", "linux_dev"]);

  expect(created).toMatchObject({ code: 0, stdout: "linux_dev" });
  expect(stopped).toMatchObject({ code: 0, stdout: "linux_dev stopped" });
  expect(started).toMatchObject({ code: 0, stdout: "linux_dev running" });
  expect(listed.stdout).toContain("linux_dev");
  expect(removed).toMatchObject({ code: 0, stdout: "linux_dev" });
  expect(again.stderr).toContain("already gone");
  expect(await host.rows()).toEqual([]);
});

test("a setup that fails replies with its output, and the machine stays failed until delete", async () => {
  const { run, dir } = await setUp();
  const script = join(dir, "setup.sh");

  await writeFile(script, "#!/bin/sh\necho installing\necho no network >&2\nexit 7\n");

  const created = await run([
    "create",
    "dev",
    ...sizes,
    "--setup",
    script,
    "--setup-timeout",
    "30",
    "--json",
  ]);

  const listed = await run(["machines", "--json"]);

  const { error } = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        error: Schema.Struct({ message: Schema.String, tag: ErrorTag, retryable: Schema.Boolean }),
      }),
    ),
  )(created.stdout);

  expect(created.code).toBe(1);
  expect(error.tag).toBe("Precondition");
  expect(error.message).toContain("setup exited 7");
  expect(error.message).toContain("installing\nno network");
  expect(listed.stdout).toContain('"status":"failed"');
  expect((await run(["delete", "linux_dev"])).code).toBe(0);
});

test("a duplicate name is Conflict, and the hosts listing names the host's bases", async () => {
  const { run } = await setUp();

  await run(["create", "dev", ...sizes]);

  const duplicate = await run(["create", "linux_dev", ...sizes]);
  const hosts = await run(["hosts"]);

  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain("Conflict: machine linux_dev exists");
  expect(hosts.stdout).toContain("ubuntu");
});

test("a create sent to a host under another host's ID is Invalid at the host, and makes nothing", async () => {
  const { host, dir } = await setUp();
  const config = join(dir, "misnamed.json");

  await writeFile(config, JSON.stringify({ hosts: [{ id: "mis", url: host.url }] }));

  const created = await cli(["create", "mis_dev", ...sizes, "--config", config], {
    http: NodeHttpClient.layerNodeHttp,
  });

  expect(created.code).toBe(1);
  expect(created.stderr).toContain("Invalid: mis_dev names host mis, and this is host linux");
  expect(await host.rows()).toEqual([]);
});

test("fork, checkpoint capture/list/get/delete and restore run on the host", async () => {
  const { host, run } = await setUp();

  await run(["create", "dev", ...sizes]);

  const forked = await run(["fork", "linux_dev", "copy"]);
  const captured = await run(["checkpoint", "capture", "linux_dev", "snap"]);
  const listed = await run(["checkpoint", "list"]);
  const got = await run(["checkpoint", "get", "linux_snap", "--json"]);
  const removed = await run(["delete", "linux_dev"]);
  const restored = await run(["restore", "linux_snap", "dev"]);
  const machines = await run(["machines"]);
  const checkpointRemoved = await run(["checkpoint", "delete", "linux_snap", "--json"]);
  const again = await run(["checkpoint", "delete", "linux_snap"]);
  const checkpointsAfter = await run(["checkpoint", "list"]);

  expect(forked).toMatchObject({ code: 0, stdout: "linux_copy" });
  expect(captured).toMatchObject({ code: 0, stdout: "linux_snap" });
  expect(listed.stdout).toContain("linux_snap");
  expect(listed.stdout).toContain("ram");
  expect(
    Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ id: Schema.String, machine: Schema.String, kind: Schema.String }),
      ),
    )(got.stdout, { onExcessProperty: "ignore" }),
  ).toEqual({ id: "linux_snap", machine: "linux_dev", kind: "ram" });
  expect(removed).toMatchObject({ code: 0, stdout: "linux_dev" });
  expect(restored).toMatchObject({ code: 0, stdout: "linux_dev" });
  expect(machines.stdout).toContain("linux_copy");
  expect(machines.stdout).toContain("linux_dev");
  expect(checkpointRemoved).toMatchObject({
    code: 0,
    stdout: JSON.stringify({ deleted: "linux_snap" }),
  });
  expect(again.stderr).toContain("already gone");
  expect(checkpointsAfter.stdout).not.toContain("linux_snap");
  expect(await host.checkpointRows()).toEqual([]);
});

import { join } from "node:path";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";
import { startHost } from "@clankerbox/host/testing";
import { ErrorDocument, UnreachableDocument } from "../src/command.ts";
import { cli } from "./support.ts";

const refusedUrl = Effect.gen(function* () {
  const gone = yield* startHost(yield* scratch);

  yield* gone.dispose;

  return gone.url;
});

const setUp = (down: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const host = yield* startHost(dir);
    const config = join(dir, "config.json");

    const others = yield* Effect.forEach(down, (id) =>
      Effect.map(refusedUrl, (url) => ({ id, url })),
    );

    yield* write(config, JSON.stringify({ hosts: [{ id: "linux", url: host.url }, ...others] }));

    const run = (args: ReadonlyArray<string>) =>
      cli([...args, "--config", config], { http: NodeHttpClient.layerNodeHttp });

    return { host, run, dir };
  });

const sizes = ["--base", "ubuntu", "--cpu", "1", "--ram", "1G", "--disk", "10G"];

const decodeFailure = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ error: ErrorDocument })),
);

// The host runs on the real clock, as it does in `clankerbox host`.
layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("create, stop, start and delete run on the host, and the CLI prints each outcome", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setUp();

      const created = yield* run(["create", "dev", ...sizes]);
      const stopped = yield* run(["stop", "linux_dev"]);
      const started = yield* run(["start", "linux_dev"]);
      const listed = yield* run(["machines"]);
      const removed = yield* run(["delete", "linux_dev"]);
      const again = yield* run(["delete", "linux_dev"]);

      expect(created).toMatchObject({ code: 0, stdout: "linux_dev" });
      expect(stopped).toMatchObject({ code: 0, stdout: "linux_dev stopped" });
      expect(started).toMatchObject({ code: 0, stdout: "linux_dev running" });
      expect(listed.stdout).toContain("linux_dev");
      expect(removed).toMatchObject({ code: 0, stdout: "linux_dev" });
      expect(again.stderr).toContain("already gone");
      expect(yield* host.run(host.store.list)).toEqual([]);
    }),
  );

  it.effect(
    "a setup that fails replies with its output, and the machine stays failed until delete",
    () =>
      Effect.gen(function* () {
        const { run, dir } = yield* setUp();
        const script = join(dir, "setup.sh");

        yield* write(script, "#!/bin/sh\necho installing\necho no network >&2\nexit 7\n");

        const created = yield* run([
          "create",
          "dev",
          ...sizes,
          "--setup",
          script,
          "--setup-timeout",
          "30s",
          "--json",
        ]);

        const listed = yield* run(["machines", "--json"]);

        const { error } = decodeFailure(created.stdout);

        expect(created.code).toBe(1);
        expect(error.tag).toBe("Precondition");
        expect(error.message).toContain("setup exited 7");
        expect(error.message).toContain("installing\nno network");
        expect(listed.stdout).toContain('"status":"failed"');
        expect((yield* run(["delete", "linux_dev"])).code).toBe(0);
      }),
  );

  it.effect("a duplicate name is Conflict, and the hosts listing names the host's bases", () =>
    Effect.gen(function* () {
      const { run } = yield* setUp();

      yield* run(["create", "dev", ...sizes]);

      const duplicate = yield* run(["create", "dev", ...sizes, "--host", "linux"]);
      const hosts = yield* run(["hosts"]);

      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain("Conflict: machine linux_dev exists");
      expect(hosts.stdout).toContain("ubuntu");
    }),
  );

  it.effect(
    "a create sent to a host under another host's ID is Invalid at the host, and makes nothing",
    () =>
      Effect.gen(function* () {
        const { host, dir } = yield* setUp();
        const config = join(dir, "misnamed.json");

        yield* write(config, JSON.stringify({ hosts: [{ id: "mis", url: host.url }] }));

        const created = yield* cli(
          ["create", "dev", ...sizes, "--host", "mis", "--config", config],
          {
            http: NodeHttpClient.layerNodeHttp,
          },
        );

        expect(created.code).toBe(1);
        expect(created.stderr).toContain("Invalid: mis_dev names host mis, and this is host linux");
        expect(yield* host.run(host.store.list)).toEqual([]);
      }),
  );

  it.effect("fork, checkpoint capture/list/get/delete and restore run on the host", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setUp();

      yield* run(["create", "dev", ...sizes]);

      const forked = yield* run(["fork", "linux_dev", "copy"]);
      const captured = yield* run(["checkpoint", "capture", "linux_dev", "snap"]);
      const listed = yield* run(["checkpoint", "list"]);
      const got = yield* run(["checkpoint", "get", "linux_snap", "--json"]);
      const fields = yield* run(["checkpoint", "get", "linux_snap"]);
      const removed = yield* run(["delete", "linux_dev"]);
      const restored = yield* run(["restore", "linux_snap", "dev"]);
      const machines = yield* run(["machines"]);
      const checkpointRemoved = yield* run(["checkpoint", "delete", "linux_snap", "--json"]);
      const again = yield* run(["checkpoint", "delete", "linux_snap"]);
      const checkpointsAfter = yield* run(["checkpoint", "list"]);

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
      expect(fields.stdout.split("\n").map((line) => line.split(/\s{2,}/u))).toEqual(
        expect.arrayContaining([
          ["ID", "linux_snap"],
          ["MACHINE", "linux_dev"],
          ["RAM", "1G"],
          ["DISK", "10G"],
          ["ACTION", "capture done"],
          ["ERROR", "-"],
        ]),
      );
      expect(removed).toMatchObject({ code: 0, stdout: "linux_dev" });
      expect(restored).toMatchObject({ code: 0, stdout: "linux_dev" });
      expect(machines.stdout).toContain("linux_copy");
      expect(machines.stdout).toContain("linux_dev");
      expect(checkpointRemoved).toMatchObject({
        code: 0,
        stdout: JSON.stringify({ deleted: "linux_snap" }),
      });
      expect(again.stderr).toContain("already gone");
      expect(checkpointsAfter).toMatchObject({
        stdout: "",
        stderr: "clankerbox: no checkpoints to list",
      });
      expect(yield* host.run(host.store.checkpoints)).toEqual([]);
    }),
  );

  it.effect(
    "machines shows each machine's age and names the host that is down; hosts --json names the runtime",
    () =>
      Effect.gen(function* () {
        const { run } = yield* setUp(["mac"]);

        yield* run(["create", "dev", ...sizes]);

        const table = yield* run(["machines"]);
        const row = table.stdout.split("\n").find((line) => line.startsWith("linux_dev"));
        const hosts = yield* run(["hosts", "--json"]);

        expect(table.code).toBe(0);
        expect(table.stdout.split("\n")[0]).toContain("AGE");
        expect(row?.split(/\s+/u)).toContain("running");
        expect(row).toMatch(/\s\d+[smhd]\s/u);
        expect(table.stderr).toContain("Unavailable: host mac");
        expect(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({
                hosts: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    runtime: Schema.String,
                    bases: Schema.Array(Schema.String),
                  }),
                ),
                unreachable: Schema.Array(UnreachableDocument),
              }),
            ),
          )(hosts.stdout, { onExcessProperty: "ignore" }),
        ).toEqual({
          hosts: [{ id: "linux", runtime: "smolvm", bases: ["ubuntu"] }],
          unreachable: [{ host: "mac", error: expect.objectContaining({ tag: "Unavailable" }) }],
        });
      }),
  );

  it.effect("--json errors from the host carry their tags", () =>
    Effect.gen(function* () {
      const { run } = yield* setUp(["mac"]);

      const notFound = yield* run(["start", "linux_nope", "--json"]);
      const invalid = yield* run(["create", "bad--name", ...sizes, "--json"]);

      const precondition = yield* run([
        "create",
        "nobase",
        "--host",
        "linux",
        ...sizes.slice(2),
        "--base",
        "nope",
        "--json",
      ]);

      const unavailable = yield* run(["start", "mac_dev", "--json"]);

      expect(decodeFailure(notFound.stdout).error.tag).toBe("NotFound");
      expect(decodeFailure(invalid.stdout).error.tag).toBe("Invalid");
      expect(decodeFailure(precondition.stdout).error).toMatchObject({ tag: "Precondition" });
      expect(decodeFailure(precondition.stdout).error.message).toContain("ubuntu");
      expect(decodeFailure(unavailable.stdout).error).toMatchObject({
        tag: "Unavailable",
        retryable: false,
      });

      for (const ran of [notFound, invalid, precondition, unavailable]) {
        expect(ran.code).toBe(1);
      }
    }),
  );
});

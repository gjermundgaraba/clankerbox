import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  read,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { stubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { loginSetup, running } from "@gjermundgaraba/clankerbox-server/testing";
import { Effect, Schema, Stdio, Stream } from "effect";
import { expect, vi } from "vite-plus/test";

import { ErrorDocument } from "../src/command.ts";
import { renderSshConfig } from "../src/ssh-config.ts";
import { cli, writeConfig } from "./support.ts";
import type { CliRun } from "./support.ts";

vi.setConfig({ testTimeout: 30_000 });

const http = NodeHttpClient.layerNodeHttp;

const setUp = (options?: Parameters<typeof running>[0]) =>
  Effect.gen(function* () {
    const served = yield* Effect.orDie(running(options));
    const { dir, url } = served;
    const config = path.join(dir, "config.json");

    yield* write(config, JSON.stringify({ server: url }));

    const run = (args: readonly string[]) =>
      cli([...args, "--config", config], { http });

    return { ...served, run };
  });

const twoHosts = { hosts: [{ id: "alpha" }, { id: "beta" }] };

const sizes = [
  "--base",
  "ubuntu",
  "--cpu",
  "1",
  "--ram",
  "1G",
  "--disk",
  "10G",
];

const setupScript = `#!/bin/sh
set -eu
${loginSetup}echo set-up >"$CLANKERBOX_ROOT/setup-ran"
`;

const setupRuns = (dir: string) =>
  Effect.map(
    read(path.join(dir, "setup-runs")),
    (text) => text.trim().split("\n").length
  );

const countedTemplate = (dir: string) =>
  Effect.gen(function* () {
    const file = path.join(dir, "web.yaml");

    yield* write(
      path.join(dir, "web-setup.sh"),
      `#!/bin/sh
set -eu
${loginSetup}echo ran >>"${path.join(dir, "setup-runs")}"
`
    );
    yield* write(
      file,
      "base: ubuntu\ncpu: 1\nram: 1G\ndisk: 10G\nsetup: web-setup.sh\n"
    );

    return file;
  });

const decodeJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text, {
    onExcessProperty: "ignore",
  });

const MachineJson = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  phase: Schema.String,
  cpu: Schema.Int,
  ramMib: Schema.Int,
  diskGib: Schema.Int,
  hostKey: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ _tag: Schema.String })),
});

const HostsJson = Schema.Struct({
  hosts: Schema.Array(
    Schema.Struct({ id: Schema.String, runtimeVersion: Schema.String })
  ),
});

const CapacityJson = Schema.Struct({
  usage: Schema.Array(
    Schema.Struct({
      host: Schema.String,
      resource: Schema.String,
      used: Schema.optionalKey(Schema.Int),
      limit: Schema.optionalKey(Schema.Int),
    })
  ),
  unreachable: Schema.Array(Schema.String),
});

const used = (text: string) =>
  Effect.map(decodeJson(CapacityJson, text), ({ usage }) =>
    usage.map(({ resource, used: amount }) => [resource, amount])
  );

const decodeFailure = (text: string) =>
  Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ error: ErrorDocument }))
  )(text, { onExcessProperty: "error" });

const answersOnUndone = (
  run: (args: readonly string[]) => Effect.Effect<CliRun>
) => {
  const outcome = (args: readonly string[]) =>
    Effect.map(run([...args, "--json"]), ({ code, stdout }) =>
      code === 0 ? "answered" : decodeFailure(stdout).error.tag
    );

  return Effect.all({
    started: outcome(["start", "dev"]),
    removed: outcome(["delete", "other"]),
    gone: outcome(["get", "other"]),
    replaced: outcome(["create", "dev", ...sizes]),
  });
};

const fieldsOf = (text: string) =>
  text.split("\n").map((line) => line.split(/\s{2,}/u));

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "create, pause, stop, start and delete reach the VM, and the CLI prints each outcome",
    () =>
      Effect.gen(function* () {
        const { hosts, run } = yield* setUp();

        const created = yield* run(["create", "dev", ...sizes]);
        const paused = yield* run(["pause", "dev"]);
        const stopped = yield* run(["stop", "dev"]);
        const started = yield* run(["start", "dev"]);
        const listed = yield* run(["machines"]);
        const got = yield* run(["get", "dev"]);
        const removed = yield* run(["delete", "dev"]);
        const again = yield* run(["delete", "dev"]);
        const after = yield* run(["machines"]);

        expect(created).toMatchObject({ code: 0, stdout: "dev" });
        expect(paused).toMatchObject({ code: 0, stdout: "dev paused" });
        expect(stopped).toMatchObject({ code: 0, stdout: "dev stopped" });
        expect(started).toMatchObject({ code: 0, stdout: "dev running" });
        expect(listed.stdout).toContain("dev");
        expect(fieldsOf(got.stdout)).toStrictEqual(
          expect.arrayContaining([
            ["ID", "dev"],
            ["STATE", "running"],
            ["DESIRED", "running"],
            ["PHASE", "settled"],
          ])
        );
        expect(removed).toMatchObject({ code: 0, stdout: "dev" });
        expect(again.stderr).toContain("already gone");
        expect(after).toMatchObject({
          code: 0,
          stdout: "",
          stderr: "clankerbox: no machines to list",
        });
        expect(hosts[0]?.fake.machines.size).toBe(0);
      })
  );

  it.effect(
    "a client that knows one URL sees bare names, and no host in anything it prints of a machine",
    () =>
      Effect.gen(function* () {
        const { dir, url } = yield* setUp(twoHosts);
        const config = path.join(dir, "bare.json");

        yield* write(config, JSON.stringify({ server: url }));

        const run = (args: readonly string[]) =>
          cli([...args, "--config", config], { http });

        const created = yield* run(["create", "dev", ...sizes]);
        const json = yield* run(["get", "dev", "--json"]);

        const outputs = [
          created.stdout,
          json.stdout,
          (yield* run(["get", "dev"])).stdout,
          (yield* run(["machines"])).stdout,
          (yield* run(["machines", "--json"])).stdout,
          (yield* run(["stop", "dev", "--json"])).stdout,
          (yield* run(["start", "dev"])).stdout,
        ];

        expect(created).toMatchObject({ code: 0, stdout: "dev" });
        expect((yield* decodeJson(MachineJson, json.stdout)).id).toBe("dev");
        expect(JSON.parse(json.stdout)).not.toHaveProperty("host");

        for (const output of outputs) {
          expect(output).not.toMatch(/alpha|beta|\w+_dev/u);
        }
      })
  );

  it.effect(
    "a create on a full host lands on the next one, and the client sees no difference",
    () =>
      Effect.gen(function* () {
        const { run } = yield* setUp({
          ...twoHosts,
          runtime: { runtime: { ramBudgetMib: 2048 } },
        });

        const big = yield* run([
          "create",
          "big",
          ...sizes.slice(0, 4),
          "--ram",
          "2G",
          "--disk",
          "10G",
        ]);

        const small = yield* run(["create", "small", ...sizes]);
        const json = yield* run(["get", "small", "--json"]);
        const listed = yield* run(["machines"]);
        const capacity = yield* run(["capacity", "--json"]);

        expect(big).toMatchObject({ code: 0, stdout: "big", stderr: "" });
        expect(small).toMatchObject({ code: 0, stdout: "small", stderr: "" });
        expect(yield* decodeJson(MachineJson, json.stdout)).toMatchObject({
          id: "small",
          state: "running",
          phase: "settled",
        });
        expect(json.stdout).not.toMatch(/alpha|beta/u);
        expect(listed.stdout).not.toMatch(/alpha|beta|failed/u);
        expect(
          (yield* decodeJson(CapacityJson, capacity.stdout)).usage.filter(
            ({ resource }) => resource === "ramMib"
          )
        ).toStrictEqual([
          { host: "alpha", resource: "ramMib", used: 2048, limit: 2048 },
          { host: "beta", resource: "ramMib", used: 1024, limit: 2048 },
        ]);
      })
  );

  it.effect(
    "hosts and capacity answer for an operator, and say which host is unreachable",
    () =>
      Effect.gen(function* () {
        const { hosts, run } = yield* setUp(twoHosts);

        yield* run(["create", "dev", ...sizes]);

        const listed = yield* run(["hosts"]);
        const json = yield* run(["hosts", "--json"]);
        const capacity = yield* run(["capacity"]);

        yield* hosts[1]?.dispose ?? Effect.void;

        const parted = yield* run(["hosts", "--json"]);
        const partedText = yield* run(["hosts"]);
        const short = yield* run(["capacity", "--json"]);
        const shortText = yield* run(["capacity"]);

        expect(listed.code).toBe(0);
        expect(listed.stdout).toMatch(/^alpha\s+up\s+linux\s/mu);
        expect(listed.stdout).toMatch(/^beta\s+up\s+linux\s/mu);
        expect(listed.stdout).toContain("ubuntu");
        expect(JSON.parse(json.stdout)).toMatchObject({
          hosts: [
            {
              id: "alpha",
              state: "up",
              kind: "linux",
              bases: ["ubuntu"],
            },
            {
              id: "beta",
              state: "up",
              kind: "linux",
              bases: ["ubuntu"],
            },
          ],
        });
        expect(
          (yield* decodeJson(HostsJson, json.stdout)).hosts.map(({ id }) => id)
        ).toStrictEqual(["alpha", "beta"]);
        expect(capacity.code).toBe(0);
        expect(capacity.stdout).toMatch(/^alpha\s+ram\s+1G\s+-$/mu);
        expect(JSON.parse(parted.stdout)).toMatchObject({
          hosts: [
            { id: "alpha", state: "up" },
            { id: "beta", state: "unreachable" },
          ],
        });
        expect(partedText.stdout).toMatch(/^beta\s+unreachable\s+-\s/mu);
        expect(
          (yield* decodeJson(CapacityJson, short.stdout)).unreachable
        ).toStrictEqual(["beta"]);
        expect(shortText.stderr).toContain("host beta didn't answer");
      })
  );

  it.effect(
    "a setup that fails replies with its output, its row says so until it is deleted, a create of the name replaces it, and the SDK's stub holding the row answers alike",
    () =>
      Effect.gen(function* () {
        const { dir, machines, run } = yield* setUp();
        const script = path.join(dir, "setup.sh");

        yield* write(
          script,
          "#!/bin/sh\necho installing\necho no network >&2\nexit 7\n"
        );

        const scripted = [
          ...sizes,
          "--setup",
          script,
          "--setup-timeout",
          "30s",
        ];

        const created = yield* run(["create", "dev", ...scripted, "--json"]);

        yield* run(["create", "other", ...scripted]);

        const held = yield* run(["get", "dev", "--json"]);
        const listed = yield* run(["machines"]);

        const { error } = decodeFailure(created.stdout);

        expect(created.code).toBe(1);
        expect(error.tag).toBe("ScriptFailed");
        expect(error.message).toContain("setup exited 7");
        expect(error.message).toContain("installing\nno network");
        expect(yield* decodeJson(MachineJson, held.stdout)).toMatchObject({
          id: "dev",
          state: "missing",
          phase: "failed",
          error: { _tag: "ScriptFailed" },
        });
        expect(listed.stdout).toContain("ScriptFailed");

        const stub = yield* Effect.acquireRelease(
          Effect.map(machines.list({}), (rows) =>
            stubServer({ machines: rows })
          ),
          (made) =>
            Effect.promise(async () => {
              await made.dispose();
            })
        );

        const stubDir = path.join(dir, "stub");

        yield* mkdir(stubDir);

        const stubConfig = yield* writeConfig(stubDir);

        const undone = {
          started: "NotFound",
          removed: "answered",
          gone: "NotFound",
          replaced: "answered",
        };

        expect(yield* answersOnUndone(run)).toStrictEqual(undone);
        expect(
          yield* answersOnUndone((args) =>
            cli([...args, "--config", stubConfig], { server: stub })
          )
        ).toStrictEqual(undone);
      })
  );

  it.effect("a duplicate name is Conflict", () =>
    Effect.gen(function* () {
      const { run } = yield* setUp(twoHosts);

      yield* run(["create", "dev", ...sizes]);

      const duplicate = yield* run(["create", "dev", ...sizes]);

      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain("Conflict");
      expect(duplicate.stderr).toContain("dev");
    })
  );

  it.effect(
    "fork, checkpoint capture, list, get and delete, and restore all work by bare name",
    () =>
      Effect.gen(function* () {
        const { run } = yield* setUp();

        yield* run(["create", "dev", ...sizes]);

        const forked = yield* run(["fork", "dev", "copy"]);
        const captured = yield* run(["checkpoint", "capture", "dev", "snap"]);
        const listed = yield* run(["checkpoint", "list"]);
        const got = yield* run(["checkpoint", "get", "snap", "--json"]);
        const fields = yield* run(["checkpoint", "get", "snap"]);
        const removed = yield* run(["delete", "dev"]);
        const restored = yield* run(["restore", "snap", "dev"]);
        const machines = yield* run(["machines"]);

        const checkpointRemoved = yield* run([
          "checkpoint",
          "delete",
          "snap",
          "--json",
        ]);

        const again = yield* run(["checkpoint", "delete", "snap"]);
        const checkpointsAfter = yield* run(["checkpoint", "list"]);

        expect(forked).toMatchObject({ code: 0, stdout: "copy" });
        expect(captured).toMatchObject({ code: 0, stdout: "snap" });
        expect(listed.stdout).toMatch(/^snap\s+ready\s+ram\s+dev\s/mu);
        expect(
          yield* decodeJson(
            Schema.Struct({
              id: Schema.String,
              machine: Schema.String,
              kind: Schema.String,
              phase: Schema.String,
            }),
            got.stdout
          )
        ).toStrictEqual({
          id: "snap",
          machine: "dev",
          kind: "ram",
          phase: "ready",
        });
        expect(fieldsOf(fields.stdout)).toStrictEqual(
          expect.arrayContaining([
            ["ID", "snap"],
            ["MACHINE", "dev"],
            ["RAM", "1G"],
            ["DISK", "10G"],
          ])
        );
        expect(removed).toMatchObject({ code: 0, stdout: "dev" });
        expect(restored).toMatchObject({ code: 0, stdout: "dev" });
        expect(machines.stdout).toMatch(/^copy\s/mu);
        expect(machines.stdout).toMatch(/^dev\s/mu);
        expect(checkpointRemoved).toMatchObject({
          code: 0,
          stdout: JSON.stringify({ deleted: "snap" }),
        });
        expect(again.stderr).toContain("already gone");
        expect(checkpointsAfter).toMatchObject({
          stdout: "",
          stderr: "clankerbox: no checkpoints to list",
        });
      })
  );

  it.effect("machines shows each machine's age and its state", () =>
    Effect.gen(function* () {
      const { run } = yield* setUp();

      yield* run(["create", "dev", ...sizes]);

      const table = yield* run(["machines"]);

      const row = table.stdout
        .split("\n")
        .find((line) => line.startsWith("dev"));

      expect(table.code).toBe(0);
      expect(table.stdout.split("\n")[0]).toContain("AGE");
      expect(row?.split(/\s+/u)).toContain("running");
      expect(row).toMatch(/\s\d+[smhd]\s/u);
    })
  );

  it.effect(
    "a setup that succeeds runs in the machine, records the host key, and ssh-known-hosts prints it for a .cbx name",
    () =>
      Effect.gen(function* () {
        const { dir, hosts, run } = yield* setUp();
        const script = path.join(dir, "setup.sh");

        yield* write(script, setupScript);

        const created = yield* run([
          "create",
          "dev",
          ...sizes,
          "--setup",
          script,
        ]);

        const machine = yield* decodeJson(
          MachineJson,
          (yield* run(["get", "dev", "--json"])).stdout
        );

        const known = yield* run(["ssh-known-hosts", "dev.cbx", "dev.cbx"]);

        const ran = yield* read(
          path.join(hosts[0]?.fake.root("dev") ?? "", "setup-ran")
        );

        expect(created).toMatchObject({ code: 0, stdout: "dev" });
        expect(machine.hostKey).toMatch(/^ssh-ed25519 /u);
        expect(known).toMatchObject({
          code: 0,
          stdout: `dev.cbx ${machine.hostKey}`,
        });
        expect(ran).toBe("set-up\n");
      })
  );

  it.effect(
    "a command on the default config keeps the one SSH block for every machine",
    () =>
      Effect.gen(function* () {
        const { dir, url } = yield* setUp();

        yield* mkdir(path.join(dir, ".config", "clankerbox"));
        yield* write(
          path.join(dir, ".config", "clankerbox", "config.json"),
          JSON.stringify({ server: url })
        );

        const listed = yield* cli(["machines"], {
          http,
          env: { HOME: dir },
        });

        expect(listed.code).toBe(0);
        expect(yield* read(path.join(dir, ".ssh", "clankerbox"))).toBe(
          renderSshConfig("/bin/sh")
        );
        expect(yield* read(path.join(dir, ".ssh", "config"))).toContain(
          "Include clankerbox"
        );
      })
  );

  it.effect(
    "a create from a template, also at larger sizes, runs no setup, and the build's copy lists as no checkpoint",
    () =>
      Effect.gen(function* () {
        const { dir, run } = yield* setUp();
        const file = yield* countedTemplate(dir);
        const built = yield* run(["template", "build", file]);

        const checkpoints = yield* run(["checkpoint", "list"]);
        const fast = yield* run(["create", "fast", "--template", "web"]);

        const large = yield* run([
          "create",
          "large",
          "--template",
          "web",
          "--ram",
          "2G",
        ]);

        const got = yield* decodeJson(
          Schema.Struct({ template: Schema.String, ramMib: Schema.Int }),
          (yield* run(["get", "large", "--json"])).stdout
        );

        expect(built).toMatchObject({ code: 0, stdout: "web@1" });
        expect(checkpoints).toMatchObject({
          code: 0,
          stderr: "clankerbox: no checkpoints to list",
        });
        expect([fast.code, fast.stdout]).toStrictEqual([0, "fast"]);
        expect([large.code, large.stdout]).toStrictEqual([0, "large"]);
        expect(got).toStrictEqual({ template: "web@1", ramMib: 2048 });
        expect(yield* setupRuns(dir)).toBe(1);
      })
  );

  it.effect("a create from a template sends no setup and no start", () =>
    Effect.gen(function* () {
      const { dir, hosts, run } = yield* setUp();
      yield* run(["template", "build", yield* countedTemplate(dir)]);

      const created = yield* run(["create", "box", "--template", "web"]);

      const got = yield* decodeJson(
        MachineJson,
        (yield* run(["get", "box", "--json"])).stdout
      );

      expect([created.code, created.stdout]).toStrictEqual([0, "box"]);
      expect([got.state, got.phase]).toStrictEqual(["running", "settled"]);
      expect(got.hostKey).toMatch(/^ssh-ed25519 /u);
      expect(
        hosts[0]?.fake.calls.filter((call) => call.endsWith(" box"))
      ).toStrictEqual([
        "admit box",
        "restore box",
        "exec box",
        "exec box",
        "exec box",
      ]);
      expect(yield* setupRuns(dir)).toBe(1);
    })
  );

  it.effect(
    "a create from a template whose only holder is full fails Capacity, and never moves to a host without the build",
    () =>
      Effect.gen(function* () {
        const { dir, hosts, run } = yield* setUp(twoHosts);
        yield* run(["template", "build", yield* countedTemplate(dir)]);

        const holds = ({ fake }: (typeof hosts)[number]) =>
          fake.calls.some((call) => call.startsWith("capture "));

        const holder = hosts.filter(holds);
        const others = hosts.filter((host) => !holds(host));

        for (const { fake } of holder) {
          fake.failNext("admit", new Capacity({ message: "full" }));
        }

        const refused = yield* run([
          "create",
          "fast",
          "--template",
          "web",
          "--json",
        ]);

        expect([holder.length, others.length]).toStrictEqual([1, 1]);
        expect(refused.code).toBe(1);
        expect(decodeFailure(refused.stdout).error.tag).toBe("Capacity");
        expect(
          others.flatMap(({ fake }) =>
            fake.calls.filter((call) => call.endsWith(" fast"))
          )
        ).toStrictEqual([]);
        expect(yield* setupRuns(dir)).toBe(1);
      })
  );

  it.effect(
    "resize grows a running machine live and refuses to shrink it, and capacity counts only running machines",
    () =>
      Effect.gen(function* () {
        const { run } = yield* setUp();

        yield* run(["create", "dev", ...sizes]);

        const grown = yield* run([
          "resize",
          "dev",
          "--ram",
          "2G",
          "--disk",
          "20G",
        ]);

        const shrunk = yield* run(["resize", "dev", "--ram", "1G", "--json"]);
        const hot = yield* run(["capacity", "--json"]);

        yield* run(["stop", "dev"]);

        const cold = yield* run(["resize", "dev", "--ram", "1G", "--cpu", "2"]);

        const idle = yield* run(["capacity", "--json"]);
        const disk = yield* run(["resize", "dev", "--disk", "10G", "--json"]);

        expect(grown).toMatchObject({
          code: 0,
          stdout: "dev 1 vCPUs, 2G RAM, 20G disk",
        });
        expect(decodeFailure(shrunk.stdout).error.tag).toBe("Unsizable");
        expect(yield* used(hot.stdout)).toStrictEqual([
          ["cpu", 1],
          ["ramMib", 2048],
        ]);
        expect(cold).toMatchObject({
          code: 0,
          stdout: "dev 2 vCPUs, 1G RAM, 20G disk",
        });
        expect(yield* used(idle.stdout)).toStrictEqual([
          ["cpu", 0],
          ["ramMib", 0],
        ]);
        expect(decodeFailure(disk.stdout).error.tag).toBe("Unsizable");
      })
  );

  it.effect(
    "with every host full a create fails as a retryable Capacity, its row says so, and capacity shows the limit",
    () =>
      Effect.gen(function* () {
        const { run } = yield* setUp({
          runtime: { runtime: { ramBudgetMib: 2048 } },
        });

        const first = yield* run([
          "create",
          "big",
          ...sizes.slice(0, 4),
          "--ram",
          "2G",
          "--disk",
          "10G",
        ]);

        const second = yield* run(["create", "small", ...sizes, "--json"]);
        const held = yield* run(["get", "small", "--json"]);
        const capacity = yield* run(["capacity", "--json"]);

        expect(first).toMatchObject({ code: 0, stdout: "big" });
        expect(decodeFailure(second.stdout).error).toMatchObject({
          tag: "Capacity",
          retryable: true,
        });
        expect(yield* decodeJson(MachineJson, held.stdout)).toMatchObject({
          state: "missing",
          phase: "failed",
          error: { _tag: "Capacity" },
        });
        expect(
          (yield* decodeJson(CapacityJson, capacity.stdout)).usage
        ).toContainEqual({
          host: "linux",
          resource: "ramMib",
          used: 2048,
          limit: 2048,
        });
      })
  );

  it.effect("--json errors from the control plane carry their tags", () =>
    Effect.gen(function* () {
      const { run } = yield* setUp();

      const notFound = yield* run(["start", "nope", "--json"]);
      const invalid = yield* run(["create", "bad--name", ...sizes, "--json"]);

      const notOffered = yield* run([
        "create",
        "nobase",
        ...sizes.slice(2),
        "--base",
        "nope",
        "--json",
      ]);

      expect(decodeFailure(notFound.stdout).error.tag).toBe("NotFound");
      expect(decodeFailure(invalid.stdout).error.tag).toBe("Invalid");
      expect(decodeFailure(notOffered.stdout).error.tag).toBe("NotOffered");
      expect(decodeFailure(notOffered.stdout).error.message).toContain(
        "ubuntu"
      );

      for (const ran of [notFound, invalid, notOffered]) {
        expect(ran.code).toBe(1);
      }
    })
  );

  it.effect(
    "exec runs in the VM as the user named with its env and stdin, exits with the command's code, and is WrongState on a stopped machine",
    () =>
      Effect.gen(function* () {
        const { dir, run } = yield* setUp();

        yield* run(["create", "dev", ...sizes]);

        const stdio = Stdio.layerTest({
          stdin: Stream.make(new TextEncoder().encode("secret")),
        });

        const exec = (args: readonly string[]) =>
          cli(
            [
              "exec",
              "dev",
              "--json",
              "--config",
              path.join(dir, "config.json"),
              ...args,
            ],
            { http, stdio }
          );

        const ran = yield* exec([
          "--user",
          "user",
          "--env",
          "TOKEN=t-1",
          "--stdin",
          "--",
          "/bin/sh",
          "-c",
          'printf "%s %s %s" "$CLANKERBOX_USER" "$TOKEN" "$(cat)"; exit 3',
        ]);

        yield* run(["stop", "dev"]);

        const stopped = yield* exec(["--", "true"]);

        expect(ran.code).toBe(3);
        expect(JSON.parse(ran.stdout)).toStrictEqual({
          exitCode: 3,
          output: "user t-1 secret",
          truncated: false,
        });
        expect(stopped.code).toBe(1);
        expect(decodeFailure(stopped.stdout).error).toMatchObject({
          tag: "WrongState",
          state: "stopped",
        });
      })
  );

  it.effect(
    "pause --capture holds the VM as it ran in a labelled checkpoint, which machines and checkpoint list find by label",
    () =>
      Effect.gen(function* () {
        const { hosts, run } = yield* setUp();

        yield* run(["create", "dev", ...sizes, "--label", "app=web"]);
        hosts[0]?.fake.calls.splice(0);

        const paused = yield* run([
          "pause",
          "dev",
          "--capture",
          "snap",
          "--label",
          "app=web",
          "--expires",
          "1d",
        ]);

        const machines = yield* run(["machines", "--label", "app=web"]);
        const none = yield* run(["machines", "--label", "app=api"]);
        const listed = yield* run(["checkpoint", "list", "--label", "app=web"]);
        const got = yield* run(["get", "dev"]);

        expect(paused).toMatchObject({ code: 0, stdout: "dev paused" });
        expect(hosts[0]?.fake.calls).toStrictEqual([
          "capture snap",
          "pause dev",
        ]);
        expect(machines.stdout).toContain("dev");
        expect(none.stderr).toBe("clankerbox: no machines to list");
        expect(listed.stdout).toContain("snap");
        expect(fieldsOf(got.stdout)).toStrictEqual(
          expect.arrayContaining([
            ["STATE", "paused"],
            ["LABELS", "app=web"],
          ])
        );
      })
  );

  it.effect(
    "a request for a machine whose host is down waits for it, its --timeout ending the wait saying the request is saved, and the machine still reads",
    () =>
      Effect.gen(function* () {
        const { hosts, run } = yield* setUp();

        yield* run(["create", "dev", ...sizes]);
        yield* hosts[0]?.dispose ?? Effect.void;

        const stopped = yield* run([
          "stop",
          "dev",
          "--json",
          "--timeout",
          "1s",
        ]);

        const held = yield* run(["get", "dev", "--json"]);
        const { error } = decodeFailure(stopped.stdout);

        expect(stopped.code).toBe(1);
        expect(error).toMatchObject({
          tag: "Unavailable",
          retryable: false,
          readOnly: false,
        });
        expect(error.message).toContain("the request is saved");
        expect(held.code).toBe(0);
        expect(yield* decodeJson(MachineJson, held.stdout)).toMatchObject({
          id: "dev",
          phase: "waiting",
        });
      })
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import { DateTime, Effect, Schema } from "effect";
import { layer } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import {
  machine,
  mkdir,
  type StubHost,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { UnreachableDocument } from "../src/command.ts";
import { cleanup, cli, decodeJsonError, hostIn, sizes, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const host = hostIn(stubs);

layer(NodeServices.layer)((it) => {
  it.effect("machines shows each machine's age, and names a host that didn't answer", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux", "mac"]);
      const createdAt = DateTime.subtract(yield* DateTime.now, { days: 3, hours: 2 });

      const { code, stdout, stderr } = yield* cli(["machines", "--config", config], {
        endpoints: [
          [
            "linux",
            host({
              id: "linux",
              bases: ["ubuntu"],
              machines: [machine("linux_dev", { createdAt })],
            }),
          ],
          ["mac", "down"],
        ],
      });

      const row = stdout.split("\n").find((line) => line.startsWith("linux_dev"));

      expect(code).toBe(0);
      expect(stdout.split("\n")[0]).toContain("AGE");
      expect(row?.split(/\s+/u)).toContain("3d");
      expect(stderr).toContain("mac");
    }),
  );

  const held = machine("linux_dev", {
    ssh: { user: "root", host: "100.64.0.7", port: 10_022 },
    hostKey: "ssh-ed25519 AAAAexample",
  });

  const unmade = machine("linux_other", {
    made: false,
    action: {
      name: "create",
      status: "failed",
      error: { tag: "Precondition", message: "setup exited 3" },
    },
  });

  it.effect(
    "machines shows sizes with their units, marks an unmade machine, and leaves the SSH login to get",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);

        const { stdout } = yield* cli(["machines", "--config", config], {
          endpoints: [
            ["linux", host({ id: "linux", bases: ["ubuntu"], machines: [held, unmade] })],
          ],
        });

        const rows = stdout.split("\n");

        expect(rows).toHaveLength(3);
        expect(rows[0]?.split(/\s+/u)).toEqual([
          "ID",
          "STATE",
          "BASE",
          "PROFILE",
          "CPU",
          "RAM",
          "DISK",
          "AGE",
          "ACTION",
        ]);
        expect(rows[1]?.split(/\s+/u).slice(4, 7)).toEqual(["1", "1G", "10G"]);
        expect(rows[2]).toContain("running (unmade)");
      }),
  );

  it.effect("get reads one machine a field a line, with its action's error and its host key", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const endpoints = [
        ["linux", host({ id: "linux", bases: ["ubuntu"], machines: [held, unmade] })],
      ] as const;

      const fields = (id: string) =>
        Effect.map(cli(["get", id, "--config", config], { endpoints }), ({ stdout }) =>
          stdout.split("\n").map((line) => line.split(/\s{2,}/u)),
        );

      const json = yield* cli(["get", "linux_dev", "--json", "--config", config], { endpoints });
      const gone = yield* cli(["get", "linux_gone", "--json", "--config", config], { endpoints });

      expect(yield* fields("linux_dev")).toEqual(
        expect.arrayContaining([
          ["ID", "linux_dev"],
          ["STATE", "running"],
          ["RAM", "1G"],
          ["DISK", "10G"],
          ["SSH", "root@100.64.0.7:10022"],
          ["ERROR", "-"],
          ["HOST_KEY", "ssh-ed25519 AAAAexample"],
        ]),
      );
      expect(yield* fields("linux_other")).toEqual(
        expect.arrayContaining([
          ["STATE", "running (unmade)"],
          ["ACTION", "create failed: Precondition"],
          ["SSH", "-"],
          ["ERROR", "setup exited 3"],
          ["HOST_KEY", "-"],
        ]),
      );
      expect(JSON.parse(json.stdout)).toMatchObject({
        id: "linux_dev",
        ssh: held.ssh,
        hostKey: held.hostKey,
      });
      expect([gone.code, decodeJsonError(gone.stdout).error.tag]).toEqual([1, "NotFound"]);
    }),
  );

  it.effect("machines --json carries the machines and the unreachable hosts", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux", "mac"]);

      const { code, stdout } = yield* cli(["machines", "--json", "--config", config], {
        endpoints: [
          ["linux", host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] })],
          ["mac", "down"],
        ],
      });

      const document = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            machines: Schema.Array(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
            unreachable: Schema.Array(UnreachableDocument),
          }),
        ),
      )(stdout);

      expect(code).toBe(0);
      expect(document.machines.map(({ id }) => id)).toEqual(["linux_dev"]);
      expect(document.machines[0]?.createdAt).toBe("2026-10-01T00:00:00.000Z");
      expect(document.unreachable).toEqual([
        { host: "mac", error: expect.objectContaining({ tag: "Unavailable", retryable: true }) },
      ]);
    }),
  );

  it.effect(
    "create NAME is placed on the first host that offers the base and prints the new ID",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["mac", "linux"]);
        const linux = host({ id: "linux", bases: ["ubuntu"] });

        const { code, stdout } = yield* cli(["create", "dev", ...sizes, "--config", config], {
          endpoints: [
            ["mac", host({ id: "mac", bases: ["tahoe"] })],
            ["linux", linux],
          ],
        });

        expect(code).toBe(0);
        expect(stdout).toBe("linux_dev");
        expect(
          linux.creates.map(({ id, cpu, ramMib, diskGib }) => ({ id, cpu, ramMib, diskGib })),
        ).toEqual([{ id: "linux_dev", cpu: 2, ramMib: 4096, diskGib: 20 }]);
      }),
  );

  it.effect(
    "create --profile NAME reads NAME.json from the profiles directory, with its label, setup and host",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const profiles = join(dir, "profiles");

        yield* mkdir(join(profiles, "dev-recipe", "files"));
        yield* write(join(profiles, "dev-recipe", "setup.sh"), "#!/bin/sh\ntrue\n");
        yield* write(join(profiles, "dev-recipe", "files", "a"), "a\n");
        yield* write(
          join(profiles, "dev.json"),
          JSON.stringify({
            base: "ubuntu",
            cpu: 2,
            ramMib: 4096,
            diskGib: 20,
            setup: { path: "dev-recipe", timeoutSeconds: 900 },
            host: "hetzner",
          }),
        );

        const config = yield* writeConfig(dir, ["linux", "hetzner"], "profiles");
        const linux = host({ id: "linux", bases: ["ubuntu"] });
        const hetzner = host({ id: "hetzner", bases: ["ubuntu"] });

        const { code, stdout } = yield* cli(
          ["create", "box", "--profile", "dev", "--config", config],
          {
            endpoints: [
              ["linux", linux],
              ["hetzner", hetzner],
            ],
          },
        );

        const [request] = hetzner.creates;

        expect(code).toBe(0);
        expect(stdout).toBe("hetzner_box");
        expect(linux.creates).toHaveLength(0);
        expect(request?.profile).toBe("dev");
        expect(request?.setup?.timeoutSeconds).toBe(900);
        expect(request?.setup?.script.startsWith("#!/bin/sh\n")).toBe(true);
      }),
  );

  it.effect(
    "create --host sends the create to that host, over placement and the profile's host",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const file = join(dir, "dev.json");

        yield* write(
          file,
          JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10, host: "linux" }),
        );

        const config = yield* writeConfig(dir, ["linux", "hetzner"]);
        const linux = host({ id: "linux", bases: ["ubuntu"] });
        const hetzner = host({ id: "hetzner", bases: ["ubuntu"] });

        const endpoints = [
          ["linux", linux],
          ["hetzner", hetzner],
        ] as const;

        const bySizes = yield* cli(
          ["create", "a", ...sizes, "--host", "hetzner", "--config", config],
          {
            endpoints,
          },
        );

        const byProfile = yield* cli(
          ["create", "b", "--profile", file, "--host", "hetzner", "--config", config],
          { endpoints },
        );

        expect([bySizes.stdout, byProfile.stdout]).toEqual(["hetzner_a", "hetzner_b"]);
        expect(linux.calls).toEqual([]);
      }),
  );

  it.effect(
    "create takes a name, not an ID, and refuses one with '_' before sending anything",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const linux = host({ id: "linux", bases: ["ubuntu"] });

        const { code, stdout } = yield* cli(
          ["create", "linux_dev", ...sizes, "--json", "--config", config],
          { endpoints: [["linux", linux]] },
        );

        expect(code).toBe(1);
        expect(decodeJsonError(stdout).error).toMatchObject({ tag: "Invalid", retryable: false });
        expect(linux.calls).toEqual([]);
      }),
  );

  it.effect("create --profile takes a path to a profile file", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const file = join(dir, "small.json");

      yield* write(file, JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }));

      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { code } = yield* cli(["create", "box", "--profile", file, "--config", config], {
        endpoints: [["linux", linux]],
      });

      expect(code).toBe(0);
      expect(linux.creates[0]?.profile).toBe("small");
    }),
  );

  it.effect("create's flags override the profile's fields, its setup and timeout included", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const file = join(dir, "dev.json");
      const script = join(dir, "other.sh");

      yield* write(
        file,
        JSON.stringify({
          base: "ubuntu",
          cpu: 2,
          ramMib: 4096,
          diskGib: 20,
          setup: { path: "missing.sh", timeoutSeconds: 900 },
        }),
      );
      yield* write(script, "#!/bin/sh\necho other\n");

      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] });

      const { code } = yield* cli(
        [
          "create",
          "box",
          "--profile",
          file,
          "--base",
          "ubuntu-dev",
          "--cpu",
          "8",
          "--setup",
          script,
          "--setup-timeout",
          "1m",
          "--config",
          config,
        ],
        { endpoints: [["linux", linux]] },
      );

      const [request] = linux.creates;

      expect(code).toBe(0);
      expect(request).toMatchObject({
        id: "linux_box",
        base: "ubuntu-dev",
        cpu: 8,
        ramMib: 4096,
        diskGib: 20,
        profile: "dev",
        setup: { timeoutSeconds: 60 },
      });
      expect(request?.setup?.script === "#!/bin/sh\necho other\n").toBe(true);
    }),
  );

  it.effect(
    "--setup and --setup-timeout each override the profile's, and a setup with no timeout leaves it to the host",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const script = join(dir, "setup.sh");
        const other = join(dir, "other.sh");
        const profile = join(dir, "small.json");

        yield* write(script, "#!/bin/sh\ntrue\n");
        yield* write(other, "#!/bin/sh\necho other\n");
        yield* write(
          profile,
          JSON.stringify({
            base: "ubuntu",
            cpu: 1,
            ramMib: 1024,
            diskGib: 10,
            setup: { path: "setup.sh", timeoutSeconds: 900 },
          }),
        );

        const linux = host({ id: "linux", bases: ["ubuntu"] });

        for (const [name, args] of [
          ["bare", [...sizes, "--setup", script]],
          ["timed", ["--profile", profile, "--setup-timeout", "60s"]],
          ["scripted", ["--profile", profile, "--setup", other]],
        ] as const) {
          const { code } = yield* cli(["create", name, ...args, "--config", config], {
            endpoints: [["linux", linux]],
          });

          expect(code).toBe(0);
        }

        expect(linux.creates.map(({ setup }) => [setup?.script, setup?.timeoutSeconds])).toEqual([
          ["#!/bin/sh\ntrue\n", undefined],
          ["#!/bin/sh\ntrue\n", 60],
          ["#!/bin/sh\necho other\n", 900],
        ]);
      }),
  );

  it.effect(
    "create refuses --setup-timeout with no setup to time, and a spec missing its base or sizes",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const profile = join(dir, "small.json");

        yield* write(
          profile,
          JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }),
        );

        const linux = host({ id: "linux", bases: ["ubuntu"] });

        const run = (args: ReadonlyArray<string>) =>
          cli(["create", "box", ...args, "--json", "--config", config], {
            endpoints: [["linux", linux]],
          });

        const runs = [
          yield* run(["--profile", profile, "--setup-timeout", "60s"]),
          yield* run(["--base", "ubuntu"]),
          yield* run(["--profile", profile, "--cpu", "0"]),
        ];

        for (const { code, stdout } of runs) {
          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error.tag).toBe("Invalid");
        }

        expect(decodeJsonError(runs[0]?.stdout ?? "").error.message).toContain("--setup-timeout");
        expect(decodeJsonError(runs[1]?.stdout ?? "").error.message).toBe(
          "create: --cpu: missing; --ram: missing; --disk: missing",
        );
        expect(decodeJsonError(runs[2]?.stdout ?? "").error.message).toBe(
          "create: --cpu: Expected a value greater than 0",
        );
        expect(linux.calls).toEqual([]);
      }),
  );

  it.effect("create --setup sends a script file as its text", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);
      const script = join(dir, "setup.sh");

      yield* write(script, "#!/bin/sh\necho set up\n");

      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { code } = yield* cli(
        [
          "create",
          "box",
          ...sizes,
          "--setup",
          script,
          "--setup-timeout",
          "60s",
          "--config",
          config,
        ],
        { endpoints: [["linux", linux]] },
      );

      expect(code).toBe(0);
      expect(linux.creates[0]?.setup?.script === "#!/bin/sh\necho set up\n").toBe(true);
      expect(linux.creates[0]?.setup?.timeoutSeconds).toBe(60);
    }),
  );

  it.effect("deleting a machine that is already gone counts as done", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const endpoints = [["linux", host({ id: "linux", bases: ["ubuntu"] })]] as const;
      const text = yield* cli(["delete", "linux_gone", "--config", config], { endpoints });

      const json = yield* cli(["delete", "linux_gone", "--json", "--config", config], {
        endpoints,
      });

      expect(text).toMatchObject({ code: 0, stdout: "" });
      expect(text.stderr).toContain("already gone");
      expect(json).toMatchObject({ code: 0, stdout: JSON.stringify({ deleted: "linux_gone" }) });
    }),
  );

  it.effect("start, stop, fork and checkpoint capture route by ID", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["mac", "linux"]);
      const mac = host({ id: "mac", bases: ["tahoe"] });
      const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });

      const endpoints = [
        ["mac", mac],
        ["linux", linux],
      ] as const;

      const runs = [
        yield* cli(["start", "linux_dev", "--config", config], { endpoints }),
        yield* cli(["stop", "linux_dev", "--config", config], { endpoints }),
        yield* cli(["fork", "linux_dev", "copy", "--config", config], { endpoints }),
        yield* cli(["checkpoint", "capture", "linux_dev", "snap", "--config", config], {
          endpoints,
        }),
      ];

      expect(runs.map(({ code }) => code)).toEqual([0, 0, 0, 0]);
      expect(runs.map(({ stdout }) => stdout)).toEqual([
        "linux_dev running",
        "linux_dev stopped",
        "linux_copy",
        "linux_snap",
      ]);
      expect(linux.calls).toEqual([
        "machine.start",
        "machine.stop",
        "machine.fork",
        "checkpoint.capture",
      ]);
      expect(mac.calls).toEqual([]);
    }),
  );
});

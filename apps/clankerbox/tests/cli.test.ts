import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Capacity, ErrorTag } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { machine, type StubHost, stubHost } from "../../../packages/contract/tests/stub-host.ts";
import { cleanup, cli, scratch, writeConfig } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = (options: Parameters<typeof stubHost>[0]) => {
  const stub = stubHost(options);

  stubs.push(stub);

  return stub;
};

/** `--json`'s error document. */
const JsonError = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ message: Schema.String, tag: ErrorTag, retryable: Schema.Boolean }),
  }),
);

const decodeJsonError = Schema.decodeUnknownSync(JsonError);

const sizes = ["--base", "ubuntu", "--cpu", "2", "--ram-mib", "4096", "--disk-gib", "20"];

test("hosts lists every host with its bases", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"]);

  const { code, stdout } = await cli(["hosts", "--config", config], {
    endpoints: [
      ["linux", host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] })],
      ["mac", host({ id: "mac", bases: ["tahoe"], runtime: "tart" })],
    ],
  });

  expect(code).toBe(0);
  expect(stdout).toContain("ubuntu,ubuntu-dev");
  expect(stdout).toContain("tahoe");
});

test("machines shows each machine's age, and names a host that didn't answer", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"]);
  const createdAt = DateTime.subtract(DateTime.nowUnsafe(), { days: 3, hours: 2 });

  const { code, stdout, stderr } = await cli(["machines", "--config", config], {
    endpoints: [
      [
        "linux",
        host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev", { createdAt })] }),
      ],
      ["mac", "down"],
    ],
  });

  const row = stdout.split("\n").find((line) => line.startsWith("linux_dev"));

  expect(code).toBe(0);
  expect(stdout.split("\n")[0]).toContain("AGE");
  expect(row?.split(/\s+/u)).toContain("3d");
  expect(stderr).toContain("mac");
});

test("machines --json carries the machines and the unreachable hosts", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"]);

  const { code, stdout } = await cli(["machines", "--json", "--config", config], {
    endpoints: [
      ["linux", host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] })],
      ["mac", "down"],
    ],
  });

  const document = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        machines: Schema.Array(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
        unreachable: Schema.Array(
          Schema.Struct({
            host: Schema.String,
            error: Schema.Struct({ tag: ErrorTag, retryable: Schema.Boolean }),
          }),
        ),
      }),
    ),
  )(stdout);

  expect(code).toBe(0);
  expect(document.machines.map(({ id }) => id)).toEqual(["linux_dev"]);
  expect(document.machines[0]?.createdAt).toBe("2026-10-01T00:00:00.000Z");
  expect(document.unreachable).toEqual([
    { host: "mac", error: expect.objectContaining({ tag: "Unavailable", retryable: true }) },
  ]);
});

test("create NAME is placed on the first host that offers the base and prints the new ID", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["mac", "linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stdout } = await cli(["create", "dev", ...sizes, "--config", config], {
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
});

test("with --json an error prints {error: {message, tag, retryable}} and exits 1", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { code, stdout } = await cli(
    [
      "create",
      "dev",
      "--base",
      "fedora",
      "--cpu",
      "1",
      "--ram-mib",
      "1",
      "--disk-gib",
      "1",
      "--json",
      "--config",
      config,
    ],
    { endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]] },
  );

  const { error } = decodeJsonError(stdout);

  expect(code).toBe(1);
  expect(error.tag).toBe("Precondition");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("linux offers ubuntu");
});

test("with --json a usage error is effect/cli's usual output, and exits 1", async () => {
  const missing = await cli(["start", "--json"]);
  const malformed = await cli(["create", "dev", "--json", ...sizes.slice(0, 2), "--cpu", "x"]);

  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("machine");
  expect(malformed.code).toBe(1);
  expect(malformed.stderr).toContain("--cpu");
});

test("with --json, --help still prints the help", async () => {
  const { code, stdout } = await cli(["machines", "--help", "--json"]);

  expect(code).toBe(0);
  expect(stdout).toContain("clankerbox machines");
});

test("a retryable error says so in --json", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { code, stdout } = await cli(
    ["create", "linux_dev", ...sizes, "--json", "--config", config],
    {
      endpoints: [
        [
          "linux",
          host({
            id: "linux",
            bases: ["ubuntu"],
            create: () => Effect.fail(new Capacity({ message: "RAM budget is full" })),
          }),
        ],
      ],
    },
  );

  expect(code).toBe(1);
  expect(decodeJsonError(stdout).error).toEqual({
    message: "RAM budget is full",
    tag: "Capacity",
    retryable: true,
  });
});

test("without --json an error goes to stderr with its tag", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { code, stdout, stderr } = await cli(["start", "mac_dev", "--config", config], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
  });

  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Invalid");
});

test("--timeout stops waiting, says the action may have run, and exits 1", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"], create: () => Effect.never });
  const endpoints = [["linux", linux]] as const;

  const text = await cli(["create", "linux_dev", ...sizes, "--timeout", "1", "--config", config], {
    endpoints,
  });

  const json = await cli(
    ["create", "linux_slow", ...sizes, "--timeout", "1", "--json", "--config", config],
    { endpoints },
  );

  expect(text.code).toBe(1);
  expect(text.stderr).toContain("may have run: read linux_dev to see");
  expect(json.code).toBe(1);
  expect(decodeJsonError(json.stdout).error).toMatchObject({
    tag: "Unavailable",
    retryable: false,
  });
  expect(linux.creates).toHaveLength(2);
});

test("--timeout bounds each host's reply: a list keeps what the others answered", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["mac", "linux"]);

  const { code, stdout } = await cli(["machines", "--timeout", "1", "--json", "--config", config], {
    endpoints: [
      ["mac", "silent"],
      ["linux", host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] })],
    ],
  });

  const document = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        machines: Schema.Array(Schema.Struct({ id: Schema.String })),
        unreachable: Schema.Array(Schema.Struct({ host: Schema.String })),
      }),
    ),
  )(stdout, { onExcessProperty: "ignore" });

  expect(code).toBe(0);
  expect(document).toEqual({ machines: [{ id: "linux_dev" }], unreachable: [{ host: "mac" }] });
});

test("--timeout starts when the create is sent: placement past a silent host still creates", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["mac", "linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stdout } = await cli(
    ["create", "dev", ...sizes, "--timeout", "1", "--config", config],
    {
      endpoints: [
        ["mac", "silent"],
        ["linux", linux],
      ],
    },
  );

  expect(code).toBe(0);
  expect(stdout).toBe("linux_dev");
  expect(linux.creates).toHaveLength(1);
});

test("--timeout must be a positive number of seconds", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  for (const seconds of ["0", "-1"]) {
    const { code } = await cli(["machines", "--timeout", seconds, "--config", config], {
      endpoints: [["linux", linux]],
    });

    expect(code, seconds).toBe(1);
  }

  expect(linux.calls).toEqual([]);
});

test("create --profile NAME reads NAME.json from the profiles directory, with its label, setup and host", async () => {
  const dir = await scratch(owned);
  const profiles = join(dir, "profiles");

  await mkdir(join(profiles, "dev-recipe", "files"), { recursive: true });
  await writeFile(join(profiles, "dev-recipe", "setup.sh"), "#!/bin/sh\ntrue\n");
  await writeFile(join(profiles, "dev-recipe", "files", "a"), "a\n");
  await writeFile(
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

  const config = await writeConfig(dir, ["linux", "hetzner"], "profiles");
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const hetzner = host({ id: "hetzner", bases: ["ubuntu"] });

  const { code, stdout } = await cli(["create", "box", "--profile", "dev", "--config", config], {
    endpoints: [
      ["linux", linux],
      ["hetzner", hetzner],
    ],
  });

  const [request] = hetzner.creates;

  expect(code).toBe(0);
  expect(stdout).toBe("hetzner_box");
  expect(linux.creates).toHaveLength(0);
  expect(request?.profile).toBe("dev");
  expect(request?.setup?.timeoutSeconds).toBe(900);
  expect(request?.setup?.script.startsWith("#!/bin/sh\n")).toBe(true);
});

test("create --profile takes a path to a profile file", async () => {
  const dir = await scratch(owned);
  const file = join(dir, "small.json");

  await writeFile(file, JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }));

  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code } = await cli(["create", "box", "--profile", file, "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(0);
  expect(linux.creates[0]?.profile).toBe("small");
});

test("create's flags override the profile's fields, and --setup with --setup-timeout replaces its setup", async () => {
  const dir = await scratch(owned);
  const file = join(dir, "dev.json");
  const script = join(dir, "other.sh");

  await writeFile(
    file,
    JSON.stringify({
      base: "ubuntu",
      cpu: 2,
      ramMib: 4096,
      diskGib: 20,
      setup: { path: "missing.sh", timeoutSeconds: 900 },
    }),
  );
  await writeFile(script, "#!/bin/sh\necho other\n");

  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] });

  const { code } = await cli(
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
      "60",
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
});

test("create refuses --setup or --setup-timeout alone, and a spec missing its base or sizes", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const script = join(dir, "setup.sh");
  const profile = join(dir, "small.json");

  await writeFile(script, "#!/bin/sh\ntrue\n");
  await writeFile(profile, JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }));

  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const run = (args: ReadonlyArray<string>) =>
    cli(["create", "box", ...args, "--json", "--config", config], {
      endpoints: [["linux", linux]],
    });

  const runs = [
    await run([...sizes, "--setup", script]),
    await run(["--profile", profile, "--setup", script]),
    await run(["--profile", profile, "--setup-timeout", "60"]),
    await run(["--base", "ubuntu"]),
  ];

  for (const { code, stdout } of runs) {
    expect(code).toBe(1);
    expect(decodeJsonError(stdout).error.tag).toBe("Invalid");
  }

  expect(decodeJsonError(runs[3]?.stdout ?? "").error.message).toContain("cpu");
  expect(linux.calls).toEqual([]);
});

test("create --setup sends a script file as its text", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const script = join(dir, "setup.sh");

  await writeFile(script, "#!/bin/sh\necho set up\n");

  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code } = await cli(
    ["create", "box", ...sizes, "--setup", script, "--setup-timeout", "60", "--config", config],
    { endpoints: [["linux", linux]] },
  );

  expect(code).toBe(0);
  expect(linux.creates[0]?.setup?.script === "#!/bin/sh\necho set up\n").toBe(true);
  expect(linux.creates[0]?.setup?.timeoutSeconds).toBe(60);
});

test("deleting a machine that is already gone counts as done", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const endpoints = [["linux", host({ id: "linux", bases: ["ubuntu"] })]] as const;
  const text = await cli(["delete", "linux_gone", "--config", config], { endpoints });
  const json = await cli(["delete", "linux_gone", "--json", "--config", config], { endpoints });

  expect(text).toMatchObject({ code: 0, stdout: "" });
  expect(text.stderr).toContain("already gone");
  expect(json).toMatchObject({ code: 0, stdout: JSON.stringify({ deleted: "linux_gone" }) });
});

test("start, stop, fork and checkpoint capture route by ID", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["mac", "linux"]);
  const mac = host({ id: "mac", bases: ["tahoe"] });
  const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });

  const endpoints = [
    ["mac", mac],
    ["linux", linux],
  ] as const;

  const runs = [
    await cli(["start", "linux_dev", "--config", config], { endpoints }),
    await cli(["stop", "linux_dev", "--config", config], { endpoints }),
    await cli(["fork", "linux_dev", "copy", "--config", config], { endpoints }),
    await cli(["checkpoint", "capture", "linux_dev", "snap", "--config", config], { endpoints }),
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
});

test("the config is read from $XDG_CONFIG_HOME/clankerbox/config.json without --config", async () => {
  const dir = await scratch(owned);

  await mkdir(join(dir, "clankerbox"));
  await writeConfig(join(dir, "clankerbox"), ["linux"]);

  const { code, stdout } = await cli(["hosts"], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
    env: { XDG_CONFIG_HOME: dir },
  });

  expect(code).toBe(0);
  expect(stdout).toContain("ubuntu");
});

test("without XDG_CONFIG_HOME the config is read from ~/.config/clankerbox/config.json", async () => {
  const dir = await scratch(owned);

  await mkdir(join(dir, ".config", "clankerbox"), { recursive: true });
  await writeConfig(join(dir, ".config", "clankerbox"), ["linux"]);

  const { code } = await cli(["hosts"], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
    env: { HOME: dir },
  });

  expect(code).toBe(0);
});

test("a config with an unknown key or a duplicate host is Invalid", async () => {
  const dir = await scratch(owned);
  const typo = join(dir, "typo.json");
  const twice = join(dir, "twice.json");

  await writeFile(
    typo,
    JSON.stringify({ hosts: [{ id: "linux", url: "http://linux.test" }], host: [] }),
  );
  await writeFile(
    twice,
    JSON.stringify({
      hosts: [
        { id: "linux", url: "http://linux.test" },
        { id: "linux", url: "http://other.test" },
      ],
    }),
  );

  for (const config of [typo, twice]) {
    const { code, stdout } = await cli(["hosts", "--json", "--config", config]);

    expect(code).toBe(1);
    expect(decodeJsonError(stdout).error.tag).toBe("Invalid");
  }
});

test("delete, checkpoint capture/list/get/delete and restore go through the real routes", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });
  const endpoints = [["linux", linux]] as const;
  const run = (args: ReadonlyArray<string>) => cli([...args, "--config", config], { endpoints });

  const captured = await run(["checkpoint", "capture", "linux_dev", "snap"]);
  const listed = await run(["checkpoint", "list"]);
  const got = await run(["checkpoint", "get", "linux_snap", "--json"]);
  const restored = await run(["restore", "linux_snap", "again"]);
  const removed = await run(["delete", "linux_dev"]);
  const machines = await run(["machines"]);
  const checkpointRemoved = await run(["checkpoint", "delete", "linux_snap", "--json"]);
  const checkpointsAfter = await run(["checkpoint", "list"]);

  expect(captured).toMatchObject({ code: 0, stdout: "linux_snap" });
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("linux_snap");
  expect(got.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ id: Schema.String, machine: Schema.String })),
    )(got.stdout, { onExcessProperty: "ignore" }),
  ).toEqual({ id: "linux_snap", machine: "linux_dev" });
  expect(restored).toMatchObject({ code: 0, stdout: "linux_again" });
  expect(removed).toMatchObject({ code: 0, stdout: "linux_dev", stderr: "" });
  expect(machines.stdout).not.toContain("linux_dev");
  expect(machines.stdout).toContain("linux_again");
  expect(checkpointRemoved).toMatchObject({
    code: 0,
    stdout: JSON.stringify({ deleted: "linux_snap" }),
  });
  expect(checkpointsAfter.stdout).not.toContain("linux_snap");
  expect(linux.calls).toContain("machine.delete");
  expect(linux.calls).toContain("checkpoint.delete");
});

test("a host URL with a trailing slash still reaches its routes", async () => {
  const dir = await scratch(owned);
  const config = join(dir, "config.json");

  await writeFile(config, JSON.stringify({ hosts: [{ id: "linux", url: "http://linux.test/" }] }));

  const { code, stdout } = await cli(["hosts", "--config", config], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
  });

  expect(code).toBe(0);
  expect(stdout).toContain("ubuntu");
});

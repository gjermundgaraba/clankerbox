import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Capacity, ErrorTag, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { machine, type StubHost, stubHost } from "../../../packages/sdk/tests/stub-host.ts";
import { cleanup, cli, type CliOptions, scratch, writeConfig } from "./support.ts";

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

const sizes = ["--base", "ubuntu", "--cpu", "2", "--ram", "4G", "--disk", "20G"];

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

test("capacity lists every host's limits, one a row, and names a host that didn't answer", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac", "boat"]);

  const endpoints: CliOptions["endpoints"] = [
    [
      "linux",
      host({
        id: "linux",
        bases: ["ubuntu"],
        capacity: [{ resource: "ramMib", limit: 14_336, used: 3072 }],
      }),
    ],
    ["mac", "down"],
    [
      "boat",
      host({
        id: "boat",
        bases: ["boat"],
        runtime: "boat",
        capacity: [
          { resource: "activeSandboxes", limit: 2, used: 1 },
          { resource: "startsPerDay", limit: 75, used: 12 },
        ],
      }),
    ],
  ];

  const { code, stdout, stderr } = await cli(["capacity", "--config", config], { endpoints });
  const json = await cli(["capacity", "--json", "--config", config], { endpoints });

  expect(code).toBe(0);
  expect(
    stdout
      .trim()
      .split("\n")
      .map((row) => row.split(/\s+/u)),
  ).toEqual([
    ["HOST", "RESOURCE", "USED", "LIMIT"],
    ["linux", "ram", "3G", "14G"],
    ["boat", "active-sandboxes", "1", "2"],
    ["boat", "starts/day", "12", "75"],
  ]);
  expect(stderr).toContain("mac");
  expect(JSON.parse(json.stdout)).toMatchObject({
    capacity: [
      { host: "linux", resource: "ramMib", limit: 14_336, used: 3072 },
      { host: "boat", resource: "activeSandboxes", limit: 2, used: 1 },
      { host: "boat", resource: "startsPerDay", limit: 75, used: 12 },
    ],
    unreachable: [{ host: "mac" }],
  });
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

test("machines shows sizes with their units, marks an unmade machine, and leaves the SSH login to get", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const { stdout } = await cli(["machines", "--config", config], {
    endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"], machines: [held, unmade] })]],
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
});

test("get reads one machine a field a line, with its action's error and its host key", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);

  const endpoints = [
    ["linux", host({ id: "linux", bases: ["ubuntu"], machines: [held, unmade] })],
  ] as const;

  const fields = async (id: string) => {
    const { stdout } = await cli(["get", id, "--config", config], { endpoints });

    return stdout.split("\n").map((line) => line.split(/\s{2,}/u));
  };

  const json = await cli(["get", "linux_dev", "--json", "--config", config], { endpoints });
  const gone = await cli(["get", "linux_gone", "--json", "--config", config], { endpoints });

  expect(await fields("linux_dev")).toEqual(
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
  expect(await fields("linux_other")).toEqual(
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

test("a list exits 1 when every host failed, still naming each one", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"]);

  for (const command of [["machines"], ["hosts"], ["checkpoint", "list"]]) {
    const { code, stdout, stderr } = await cli([...command, "--config", config], {
      endpoints: [
        ["linux", "down"],
        ["mac", "down"],
      ],
    });

    const json = await cli([...command, "--json", "--config", config], {
      endpoints: [
        ["linux", "down"],
        ["mac", "down"],
      ],
    });

    expect(code, command.join(" ")).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("clankerbox: no ");
    expect(stderr).toContain("linux");
    expect(stderr).toContain("mac");
    expect(json.code, command.join(" ")).toBe(1);
    expect(json.stdout).toContain('"unreachable":[{"host":"linux"');
  }
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
      "--ram",
      "1M",
      "--disk",
      "1G",
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

  const { code, stdout } = await cli(["create", "dev", ...sizes, "--json", "--config", config], {
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
  });

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

  const text = await cli(["create", "dev", ...sizes, "--timeout", "1s", "--config", config], {
    endpoints,
  });

  const json = await cli(
    ["create", "slow", ...sizes, "--timeout", "1s", "--json", "--config", config],
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

test("a read takes no --timeout", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code } = await cli(["machines", "--timeout", "1s", "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(1);
  expect(linux.calls).toEqual([]);
});

test("--timeout takes a duration with its units in order, and refuses a bare number or none of it", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  for (const [duration, why] of [
    ["90", "isn't a duration: write it in d, h, m and s, such as 90s or 1h30m"],
    ["30m1h", "isn't a duration: write it in d, h, m and s, such as 90s or 1h30m"],
    ["0s", "is out of range: write at least 1s"],
    ["99999999999999999999s", "is out of range: write at least 1s"],
  ] as const) {
    const { code, stderr } = await cli(
      ["start", "linux_dev", "--timeout", duration, "--config", config],
      { endpoints: [["linux", linux]] },
    );

    expect(code, duration).toBe(1);
    expect(stderr, duration).toBe(`clankerbox: Invalid: --timeout "${duration}" ${why}`);
  }

  expect(linux.calls).toEqual([]);
});

test("--ram and --disk take a size with its unit, and --disk only whole GiB", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const create = (name: string, ram: string, disk: string) =>
    cli(
      [
        "create",
        name,
        "--base",
        "ubuntu",
        "--cpu",
        "1",
        "--ram",
        ram,
        "--disk",
        disk,
        "--config",
        config,
      ],
      { endpoints: [["linux", linux]] },
    );

  const made = [
    await create("a", "512M", "10G"),
    await create("b", "1.5G", "2048M"),
    await create("c", "2GiB", "10gib"),
    await create("d", "8GB", "10Gi"),
  ];

  const refused = [
    await create("e", "4096", "10G"),
    await create("f", "1T", "10G"),
    await create("g", "1.1G", "10G"),
    await create("h", "0G", "10G"),
    await create("i", "1G", "1500M"),
  ];

  expect(made.map(({ code }) => code)).toEqual([0, 0, 0, 0]);
  expect(linux.creates.map(({ ramMib, diskGib }) => [ramMib, diskGib])).toEqual([
    [512, 10],
    [1536, 2],
    [2048, 10],
    [8192, 10],
  ]);
  expect(refused.map(({ code, stderr }) => [code, stderr])).toEqual([
    [
      1,
      `clankerbox: Invalid: --ram "4096" isn't a size: write a number and M or G, such as 512M or 8G`,
    ],
    [
      1,
      `clankerbox: Invalid: --ram "1T" isn't a size: write a number and M or G, such as 512M or 8G`,
    ],
    [1, `clankerbox: Invalid: --ram "1.1G" must come to whole MiB, and at least one`],
    [1, `clankerbox: Invalid: --ram "0G" must come to whole MiB, and at least one`],
    [1, `clankerbox: Invalid: --disk "1500M" must come to whole GiB, and at least one`],
  ]);
});

/** A profiles directory holding `dev.json`, with a setup and host, `small.json` and a non-profile. */
const writeProfiles = async (dir: string) => {
  const profiles = join(dir, "profiles");

  await mkdir(join(profiles, "dev-recipe"), { recursive: true });
  await writeFile(join(profiles, "dev-recipe", "setup.sh"), "#!/bin/sh\ntrue\n");
  await writeFile(
    join(profiles, "small.json"),
    JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }),
  );
  await writeFile(
    join(profiles, "dev.json"),
    JSON.stringify({
      base: "ubuntu-dev",
      cpu: 2,
      ramMib: 4096,
      diskGib: 20,
      setup: { path: "dev-recipe", timeoutSeconds: 900 },
      host: "hetzner",
    }),
  );
  await writeFile(join(profiles, "notes.txt"), "not a profile\n");

  return profiles;
};

test("profiles lists the profiles directory's profiles by name, without asking a host", async () => {
  const dir = await scratch(owned);

  await writeProfiles(dir);

  const config = await writeConfig(dir, ["linux"], "profiles");
  const { code, stdout } = await cli(["profiles", "--config", config]);
  const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

  expect(code).toBe(0);
  expect(rows).toEqual([
    ["NAME", "BASE", "CPU", "RAM", "DISK", "SETUP", "TIMEOUT", "HOST"],
    ["dev", "ubuntu-dev", "2", "4G", "20G", "dev-recipe", "15m", "hetzner"],
    ["small", "ubuntu", "1", "1G", "10G", "-", "-", "-"],
  ]);
});

test("profiles --json carries each profile's name and fields, with its setup path resolved", async () => {
  const dir = await scratch(owned);
  const profiles = await writeProfiles(dir);
  const config = await writeConfig(dir, ["linux"], "profiles");

  const { code, stdout } = await cli(["profiles", "--json", "--config", config]);

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    profiles: [
      {
        name: "dev",
        base: "ubuntu-dev",
        cpu: 2,
        ramMib: 4096,
        diskGib: 20,
        setup: { path: join(profiles, "dev-recipe"), timeoutSeconds: 900 },
        host: "hetzner",
      },
      { name: "small", base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 },
    ],
  });
});

test("profiles fails without a profiles directory, or on a profile that doesn't decode", async () => {
  const dir = await scratch(owned);
  const bare = await writeConfig(dir, ["linux"]);

  const unset = await cli(["profiles", "--json", "--config", bare]);

  expect(unset.code).toBe(1);
  expect(decodeJsonError(unset.stdout).error).toMatchObject({
    tag: "Invalid",
    message: expect.stringContaining("no profiles directory"),
  });

  const missing = await cli([
    "profiles",
    "--json",
    "--config",
    await writeConfig(dir, ["linux"], "absent"),
  ]);

  expect(missing.code).toBe(1);
  expect(decodeJsonError(missing.stdout).error.tag).toBe("Invalid");

  const profiles = await writeProfiles(dir);

  await writeFile(join(profiles, "broken.json"), JSON.stringify({ base: "ubuntu" }));

  const broken = await cli([
    "profiles",
    "--json",
    "--config",
    await writeConfig(dir, ["linux"], "profiles"),
  ]);

  expect(broken.code).toBe(1);
  expect(decodeJsonError(broken.stdout).error.message).toBe(
    `profile ${join(profiles, "broken.json")}: cpu: missing; ramMib: missing; diskGib: missing`,
  );
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

test("create --host sends the create to that host, over placement and the profile's host", async () => {
  const dir = await scratch(owned);
  const file = join(dir, "dev.json");

  await writeFile(
    file,
    JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10, host: "linux" }),
  );

  const config = await writeConfig(dir, ["linux", "hetzner"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const hetzner = host({ id: "hetzner", bases: ["ubuntu"] });

  const endpoints = [
    ["linux", linux],
    ["hetzner", hetzner],
  ] as const;

  const bySizes = await cli(["create", "a", ...sizes, "--host", "hetzner", "--config", config], {
    endpoints,
  });

  const byProfile = await cli(
    ["create", "b", "--profile", file, "--host", "hetzner", "--config", config],
    { endpoints },
  );

  expect([bySizes.stdout, byProfile.stdout]).toEqual(["hetzner_a", "hetzner_b"]);
  expect(linux.calls).toEqual([]);
});

test("create takes a name, not an ID, and refuses one with '_' before sending anything", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stdout } = await cli(
    ["create", "linux_dev", ...sizes, "--json", "--config", config],
    { endpoints: [["linux", linux]] },
  );

  expect(code).toBe(1);
  expect(decodeJsonError(stdout).error).toMatchObject({ tag: "Invalid", retryable: false });
  expect(linux.calls).toEqual([]);
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

test("create's flags override the profile's fields, its setup and timeout included", async () => {
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
});

test("--setup and --setup-timeout each override the profile's, and a setup with no timeout leaves it to the host", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const script = join(dir, "setup.sh");
  const other = join(dir, "other.sh");
  const profile = join(dir, "small.json");

  await writeFile(script, "#!/bin/sh\ntrue\n");
  await writeFile(other, "#!/bin/sh\necho other\n");
  await writeFile(
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
    const { code } = await cli(["create", name, ...args, "--config", config], {
      endpoints: [["linux", linux]],
    });

    expect(code).toBe(0);
  }

  expect(linux.creates.map(({ setup }) => [setup?.script, setup?.timeoutSeconds])).toEqual([
    ["#!/bin/sh\ntrue\n", undefined],
    ["#!/bin/sh\ntrue\n", 60],
    ["#!/bin/sh\necho other\n", 900],
  ]);
});

test("create refuses --setup-timeout with no setup to time, and a spec missing its base or sizes", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const profile = join(dir, "small.json");

  await writeFile(profile, JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }));

  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const run = (args: ReadonlyArray<string>) =>
    cli(["create", "box", ...args, "--json", "--config", config], {
      endpoints: [["linux", linux]],
    });

  const runs = [
    await run(["--profile", profile, "--setup-timeout", "60s"]),
    await run(["--base", "ubuntu"]),
    await run(["--profile", profile, "--cpu", "0"]),
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
});

test("create --setup sends a script file as its text", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const script = join(dir, "setup.sh");

  await writeFile(script, "#!/bin/sh\necho set up\n");

  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code } = await cli(
    ["create", "box", ...sizes, "--setup", script, "--setup-timeout", "60s", "--config", config],
    { endpoints: [["linux", linux]] },
  );

  expect(code).toBe(0);
  expect(linux.creates[0]?.setup?.script === "#!/bin/sh\necho set up\n").toBe(true);
  expect(linux.creates[0]?.setup?.timeoutSeconds).toBe(60);
});

test("prebuild captures a profile's setup, and a create of the profile then restores it", async () => {
  const dir = await scratch(owned);
  const profiles = await writeProfiles(dir);
  const config = await writeConfig(dir, ["linux"], "profiles");
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const endpoints: CliOptions["endpoints"] = [["linux", linux]];

  await writeFile(
    join(profiles, "dev.json"),
    JSON.stringify({
      base: "ubuntu",
      cpu: 2,
      ramMib: 4096,
      diskGib: 20,
      setup: { path: "dev-recipe" },
    }),
  );

  const built = await cli(["prebuild", "--profile", "dev", "--config", config], { endpoints });

  expect(built.code).toBe(0);
  expect(built.stdout).toMatch(/^linux_prebuilt-[0-9a-f]{12}$/u);
  expect(built.stderr).toBe("");

  const again = await cli(["prebuild", "--profile", "dev", "--config", config], { endpoints });

  expect(again.code).toBe(0);
  expect(again.stdout).toBe(built.stdout);
  expect(again.stderr).toMatch(
    new RegExp(
      `^clankerbox: ${built.stdout} was already prebuilt, \\d+[smhd] ago; delete it to prebuild again$`,
      "u",
    ),
  );
  expect(linux.creates).toHaveLength(1);

  const listed = await cli(["checkpoint", "list", "--config", config], { endpoints });

  expect(listed.stdout).toMatch(/PROFILE/u);
  expect(listed.stdout).toMatch(
    new RegExp(`${built.stdout}\\s+disk\\s+linux_prebuilding-\\S+\\s+ubuntu\\s+dev\\s`, "u"),
  );

  const restored = await cli(["create", "box", "--profile", "dev", "--config", config], {
    endpoints,
  });

  expect(restored.code).toBe(0);
  expect(restored.stdout).toBe("linux_box");
  expect(restored.stderr).toMatch(
    new RegExp(
      `^clankerbox: restored from the prebuild ${built.stdout}, made \\d+[smhd] ago$`,
      "u",
    ),
  );
  expect(linux.creates).toHaveLength(1);

  // Other sizes are another spec, and --fresh runs the setup whatever the host has.
  for (const flags of [["--ram", "8G"], ["--fresh"]]) {
    const before = linux.creates.length;

    const fresh = await cli(
      ["create", `box${before}`, "--profile", "dev", ...flags, "--config", config],
      { endpoints },
    );

    expect(fresh.code).toBe(0);
    expect(fresh.stderr).toBe("");
    expect(linux.creates).toHaveLength(before + 1);
  }
});

test("prebuild exits 0 when its builder can't be deleted, and names the builder on stderr", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const script = join(dir, "setup.sh");

  await writeFile(script, "#!/bin/sh\ntrue\n");

  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    deleteMachine: () => Effect.fail(new Internal({ message: "no answer" })),
  });

  const { code, stdout, stderr } = await cli(
    ["prebuild", ...sizes, "--setup", script, "--config", config],
    { endpoints: [["linux", linux]] },
  );

  expect(code).toBe(0);
  expect(stdout).toMatch(/^linux_prebuilt-[0-9a-f]{12}$/u);
  expect(stderr).toMatch(
    new RegExp(
      `^clankerbox: ${stdout} is prebuilt, but its builder linux_prebuilding-[0-9a-f]{16} couldn't be deleted, and may still run: delete it$`,
      "u",
    ),
  );
});

test("prebuild names itself in a refusal of its spec", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stderr } = await cli(["prebuild", "--base", "ubuntu", "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(1);
  expect(stderr).toBe(
    "clankerbox: Invalid: prebuild: --cpu: missing; --ram: missing; --disk: missing",
  );
  expect(linux.calls).toEqual([]);
});

test("prebuild needs a setup", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux"]);
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { code, stderr } = await cli(["prebuild", ...sizes, "--config", config], {
    endpoints: [["linux", linux]],
  });

  expect(code).toBe(1);
  expect(stderr).toBe(
    "clankerbox: Invalid: prebuild needs a setup: pass --setup, or a profile that has one",
  );
  expect(linux.calls).toEqual([]);
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

test("a config's mistakes are all named, each by its JSON path, and an empty host list by what it lacks", async () => {
  const dir = await scratch(owned);
  const wrong = join(dir, "wrong.json");
  const empty = join(dir, "empty.json");

  await writeFile(wrong, JSON.stringify({ hosts: [{ id: "Linux" }], host: [] }));
  await writeFile(empty, JSON.stringify({ hosts: [] }));

  const run = async (config: string) => (await cli(["hosts", "--config", config])).stderr;

  expect(await run(wrong)).toBe(
    `clankerbox: Invalid: client config ${wrong}: host: not a known field; hosts[0].id: a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter; hosts[0].url: missing`,
  );
  expect(await run(empty)).toBe(
    "clankerbox: Invalid: the host list is empty: a client needs a host",
  );
  expect(await run(join(dir, "absent.json"))).toBe(
    `clankerbox: Invalid: couldn't read client config ${join(dir, "absent.json")}: no such file or directory`,
  );
});

test("a list with nothing in it prints no table and says so on stderr", async () => {
  const dir = await scratch(owned);
  const config = await writeConfig(dir, ["linux", "mac"], "profiles");

  await mkdir(join(dir, "profiles"));

  const endpoints: CliOptions["endpoints"] = [
    ["linux", host({ id: "linux", bases: ["ubuntu"] })],
    ["mac", "down"],
  ];

  const machines = await cli(["machines", "--config", config], { endpoints });
  const json = await cli(["machines", "--json", "--config", config], { endpoints });
  const profiles = await cli(["profiles", "--config", config]);

  expect(machines).toMatchObject({ code: 0, stdout: "" });
  expect(machines.stderr.split("\n")[0]).toBe("clankerbox: no machines to list");
  expect(machines.stderr).toContain("Unavailable: host mac");
  expect(JSON.parse(json.stdout)).toMatchObject({ machines: [] });
  expect(profiles).toMatchObject({
    code: 0,
    stdout: "",
    stderr: `clankerbox: no profiles in ${join(dir, "profiles")}`,
  });
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

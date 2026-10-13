import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DateTime, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { machine, type StubHost } from "@gjermundgaraba/clankerbox-sdk/testing";
import { UnreachableDocument } from "../src/command.ts";
import { cleanup, cli, decodeJsonError, hostIn, scratch, sizes, writeConfig } from "./support.ts";

const owned: Array<string> = [];

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(owned, stubs));

const host = hostIn(stubs);

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

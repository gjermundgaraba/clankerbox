/**
 * The Sandbox Agent provider, live on the host under test: a sandbox made from the package's own
 * recipe, driven through Rivet's SDK, with a real prompt to a real agent. It runs on smolvm and
 * Tart, and only when the driver names an agent environment file (`--agent-env-file`, which
 * becomes `CLANKERBOX_LIVE_AGENT_ENV`): `NAME=value` lines holding an LLM credential, such as
 * `ANTHROPIC_API_KEY=…`. The file is copied into the recipe, in the run's scratch; nothing prints
 * it, and the driver's teardown redacts its values from the evidence.
 *
 * The prebuild test captures a checkpoint that holds that credential, and deletes it however it
 * ends. It checks the checkpoint's ID is free first, so it never touches one it didn't make, and
 * when `CLANKERBOX_LIVE_OWNED_CHECKPOINTS` names a file, writes the ID there before it captures,
 * for a driver whose host outlives the run to delete it should the test itself not get to.
 */
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Prebuild, readSetup } from "@gjermundgaraba/clankerbox-sdk";
import {
  type ClankerboxProvider,
  clankerbox,
  type Options,
} from "@gjermundgaraba/clankerbox-rivet-sandbox-agent";
import { Effect } from "effect";
import { SandboxAgent } from "sandbox-agent";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  decode,
  type Environment,
  environment,
  Failure,
  Hosts,
  liveOn,
  minutes,
  OneMachine,
  run,
  scratch,
  timing,
  writeFileIn,
} from "./live.ts";

const agentEnv = process.env["CLANKERBOX_LIVE_AGENT_ENV"] ?? "";

const ownedCheckpoints = process.env["CLANKERBOX_LIVE_OWNED_CHECKPOINTS"] ?? "";

/**
 * What differs by guest: the recipe, the create's base and sizes, the user the recipe runs the
 * agent as, and that user's home, where sessions start. A Claude session takes about 470 MiB.
 */
const guests = {
  smolvm: {
    recipe: "ubuntu",
    base: "ubuntu",
    cpu: 2,
    ramMib: 2048,
    diskGib: 20,
    user: "sandbox",
    home: "/home/sandbox",
  },
  tart: {
    recipe: "macos",
    base: "macos",
    cpu: 2,
    ramMib: 4096,
    diskGib: 50,
    user: "admin",
    home: "/Users/admin",
  },
} as const;

const runtime = liveOn("tart") ? "tart" : "smolvm";

const live = (liveOn("smolvm") || liveOn("tart")) && agentEnv !== "";

const recipes = fileURLToPath(
  new URL("../../../packages/rivet-sandbox-agent/recipes", import.meta.url),
);

describe.skipIf(!live)("Sandbox Agent sandboxes on the host, through the provider", () => {
  const guest = guests[runtime];
  const prefix = "clankerbox/";

  /** What the prompt has Claude write, new at every run, so no earlier run's file passes. */
  const word = `clankerbox-${randomBytes(4).toString("hex")}`;
  const file = `${guest.home}/prompted.txt`;

  let env: Environment;
  let dir: string;
  let key: string;
  let profile: string;
  let options: Options;
  let sandbox: ClankerboxProvider;
  let sdk: SandboxAgent;
  let id: string;

  beforeAll(async () => {
    env = await environment();
    dir = await scratch();
    key = join(dir, "key");

    const keygen = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);

    if (keygen.code !== 0) {
      throw new Error(`ssh-keygen exited ${keygen.code}: ${keygen.stderr}`);
    }

    // The package's recipe, with what it asks for beside it: the key and the agent's environment.
    const recipe = join(dir, "recipe");

    await cp(join(recipes, guest.recipe), recipe, { recursive: true });
    await copyFile(`${key}.pub`, join(recipe, "authorized_keys"));
    await copyFile(agentEnv, join(recipe, "agent.env"));

    profile = await writeFileIn(
      dir,
      "agent.json",
      JSON.stringify({
        base: guest.base,
        cpu: guest.cpu,
        ramMib: guest.ramMib,
        diskGib: guest.diskGib,
        host: env.host.id,
        setup: { path: "recipe", timeoutSeconds: 900 },
      }),
    );

    options = {
      hosts: [env.host],
      from: { profile },
      // Every machine of the run carries its prefix, so the driver's teardown finds it.
      namePrefix: `${env.prefix}agent`,
      sshArguments: ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=30"],
      cwd: guest.home,
    };

    sandbox = clankerbox(options);
  });

  // The driver's teardown removes the run's machines; this holds its key and the credential.
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const cli = (command: string, ...args: ReadonlyArray<string>) =>
    run(env.binary, [command, "--config", env.config, ...args]);

  const machine = async (of: string) => decode(OneMachine, await cli("get", of, "--json"));

  const checkpointCli = (command: string, ...args: ReadonlyArray<string>) =>
    run(env.binary, ["checkpoint", command, "--config", env.config, ...args]);

  /** Runs `command` in the sandbox, through the agent's own process API. */
  const inSandbox = async (agent: SandboxAgent, command: string, ...args: ReadonlyArray<string>) =>
    (await agent.runProcess({ command, args: [...args] })).stdout.trim();

  test(
    "the SDK starts a sandbox from the package's recipe, and reaches its agent through the tunnel",
    async () => {
      const started = performance.now();

      sdk = await SandboxAgent.start({ sandbox });
      timing("SandboxAgent.start from a profile, with the recipe as setup", started);
      id = (sdk.sandboxId ?? "").slice(prefix.length);

      expect(sdk.sandboxId).toBe(`${prefix}${id}`);
      expect(id.startsWith(`${env.host.id}_${env.prefix}agent-`)).toBe(true);
      expect(await machine(id)).toMatchObject({ state: "running", made: true, profile: "agent" });
      expect(await sdk.getHealth()).toEqual({ status: "ok" });
      expect(await inSandbox(sdk, "id", "-un")).toBe(guest.user);

      const { agents } = await sdk.listAgents();

      expect(agents.find((agent) => agent.id === "claude")).toMatchObject({
        installed: true,
        credentialsAvailable: true,
      });
    },
    minutes(25),
  );

  test(
    "a real prompt: Claude, with its permissions bypassed, writes a file in the sandbox",
    async () => {
      const session = await sdk.createSession({ agent: "claude" });

      // The mode Claude Code offers no root, which is why the recipe runs it as its own user.
      await session.setMode("bypassPermissions");

      const started = performance.now();

      const reply = await session.prompt([
        {
          type: "text",
          text: `Write the single word ${word} to the file ${file}, and nothing else. Then stop.`,
        },
      ]);

      timing("a Claude prompt that writes a file", started);
      expect(reply.stopReason).toBe("end_turn");
      expect(await inSandbox(sdk, "cat", file)).toBe(word);
    },
    minutes(5),
  );

  test(
    "ensureServer brings back an agent that ended, through the machine's start hook",
    async () => {
      // Over ssh, as the machine's login user, as the kill is: on macOS a pgrep through the
      // agent's own process API printed nothing, for a reason not looked into.
      const overSsh = async (...command: ReadonlyArray<string>) => {
        const ran = await cli("ssh", id, "--", ...(options.sshArguments ?? []), ...command);

        expect(ran.code, ran.stderr).toBe(0);

        return ran.stdout.trim();
      };

      const before = await overSsh("pgrep", "-x", "sandbox-agent");

      expect(before).toMatch(/^\d+$/u);
      await overSsh("pkill", "-x", "sandbox-agent");

      await sandbox.ensureServer(id);

      const after = await overSsh("pgrep", "-x", "sandbox-agent");

      expect(after).toMatch(/^\d+$/u);
      expect(after).not.toBe(before);
      expect(await sdk.getHealth()).toEqual({ status: "ok" });
    },
    minutes(5),
  );

  test(
    "a paused sandbox is a stopped machine, and the SDK reconnects to it by its ID, with its disk",
    async () => {
      await sdk.pauseSandbox();

      expect((await machine(id)).state).toBe("stopped");

      const started = performance.now();

      sdk = await SandboxAgent.start({ sandbox, sandboxId: `${prefix}${id}` });
      timing("SandboxAgent.start of a paused sandbox", started);

      expect((await machine(id)).state).toBe("running");
      expect(await sdk.getHealth()).toEqual({ status: "ok" });
      expect(await inSandbox(sdk, "cat", file)).toBe(word);
    },
    minutes(10),
  );

  // Only smolvm copies a running machine: Tart forks a stopped one, which is a cold start.
  test.skipIf(runtime !== "smolvm")(
    "a fork of a running sandbox is a sandbox of its own, warm, with the source's disk",
    async () => {
      const started = performance.now();

      const forked = await SandboxAgent.start({
        sandbox: clankerbox({ ...options, from: { machine: id }, namePrefix: `${env.prefix}warm` }),
      });

      timing("SandboxAgent.start from a fork of a running sandbox", started);

      const fork = (forked.sandboxId ?? "").slice(prefix.length);

      expect(fork.startsWith(`${env.host.id}_${env.prefix}warm-`)).toBe(true);
      expect(await forked.getHealth()).toEqual({ status: "ok" });
      expect(await inSandbox(forked, "cat", file)).toBe(word);
      expect(await inSandbox(forked, "cat", "/var/lib/clankerbox/machine-id")).toBe(fork);

      await forked.destroySandbox();

      expect(decode(Failure, await cli("get", fork, "--json")).error.tag).toBe("NotFound");
      expect(await sdk.getHealth()).toEqual({ status: "ok" });
    },
    minutes(10),
  );

  test(
    "a destroyed sandbox's machine is gone",
    async () => {
      await sdk.destroySandbox();

      expect(decode(Failure, await cli("get", id, "--json")).error.tag).toBe("NotFound");
    },
    minutes(5),
  );

  // Last, after the other sandboxes are gone: Tart runs two VMs at a time.
  test(
    "a create restores its host's prebuild of the profile, and Claude answers a real prompt in it",
    async () => {
      const [host] = decode(Hosts, await cli("hosts", "--json")).hosts;

      expect(host?.id).toBe(env.host.id);

      // The prebuild's name, from the spec as the provider and `clankerbox create` send it.
      const name = await Effect.runPromise(
        readSetup(join(dir, "recipe")).pipe(
          Effect.flatMap((script) =>
            Prebuild.nameOf(
              {
                base: guest.base,
                cpu: guest.cpu,
                ramMib: guest.ramMib,
                diskGib: guest.diskGib,
                profile: "agent",
                setup: { script },
              },
              { runtimeVersion: host?.runtimeVersion ?? "" },
            ),
          ),
          Effect.provide(NodeServices.layer),
        ),
      );

      const prebuild = `${env.host.id}_${name}`;

      // One already there isn't this run's, so the test stops before it touches anything.
      expect(decode(Failure, await checkpointCli("get", prebuild, "--json")).error.tag).toBe(
        "NotFound",
      );

      if (ownedCheckpoints !== "") {
        await appendFile(ownedCheckpoints, `${prebuild}\n`);
      }

      // Built as `clankerbox prebuild` builds one, but by a machine with the run's prefix.
      const builder = `${env.host.id}_${env.prefix}builder-${randomBytes(4).toString("hex")}`;

      try {
        try {
          const created = await cli(
            "create",
            builder.slice(env.host.id.length + 1),
            "--profile",
            profile,
            "--fresh",
            "--json",
          );

          expect(created.code, created.stderr).toBe(0);

          // Tart captures only a stopped machine.
          const stopped = runtime === "tart" ? await cli("stop", builder, "--json") : undefined;

          expect(stopped?.code ?? 0, stopped?.stderr).toBe(0);

          const captured = await checkpointCli("capture", builder, name, "--json");

          expect(captured.code, captured.stderr).toBe(0);
        } finally {
          await cli("delete", builder, "--json");
        }

        const started = performance.now();

        const restored = await SandboxAgent.start({
          sandbox: clankerbox({ ...options, namePrefix: `${env.prefix}restored` }),
        });

        timing("SandboxAgent.start from a profile, restored from its prebuild", started);

        const restoredId = (restored.sandboxId ?? "").slice(prefix.length);

        try {
          expect(await machine(restoredId)).toMatchObject({
            state: "running",
            made: true,
            profile: "agent",
            action: { name: "restore", status: "done" },
          });

          const session = await restored.createSession({ agent: "claude" });

          await session.setMode("bypassPermissions");

          const prompted = performance.now();
          const again = `${word}-restored`;

          const reply = await session.prompt([
            {
              type: "text",
              text: `Write the single word ${again} to the file ${file}, and nothing else. Then stop.`,
            },
          ]);

          timing("a Claude prompt in a sandbox restored from a prebuild", prompted);
          expect(reply.stopReason).toBe("end_turn");
          expect(await inSandbox(restored, "cat", file)).toBe(again);
        } finally {
          await restored.destroySandbox();
        }
      } finally {
        // It holds the agent's credential: gone however the test ends.
        const deleted = await checkpointCli("delete", prebuild, "--json");

        expect(deleted.code, deleted.stderr).toBe(0);
        expect(decode(Failure, await checkpointCli("get", prebuild, "--json")).error.tag).toBe(
          "NotFound",
        );
      }
    },
    minutes(40),
  );
});

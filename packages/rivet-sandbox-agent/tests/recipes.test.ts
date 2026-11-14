import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { presets } from "@gjermundgaraba/clankerbox-host/testing";
import { traits as boat } from "@gjermundgaraba/clankerbox-host/testing/boat";
import { traits as smolCloud } from "@gjermundgaraba/clankerbox-host/testing/smol-cloud";
import { fitted, mibPerGib } from "@gjermundgaraba/clankerbox-sdk";
import type { RuntimeTraits } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { Yaml } from "effect/encoding";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { agentPort, healthPath } from "../src/agent.ts";
import { childLimit, testLimit } from "./child.ts";

type Recipe = "ubuntu" | "macos";

const recipes: readonly Recipe[] = ["ubuntu", "macos"];

const recipeFile = (name: Recipe, file: string) =>
  new URL(`../recipes/${name}/${file}`, import.meta.url);

const setupOf = async (name: Recipe) =>
  await readFile(recipeFile(name, "setup.sh"), "utf-8");

const ran = (
  program: string,
  args: readonly string[],
  {
    bin = [],
    input,
  }: { readonly bin?: readonly string[]; readonly input?: string } = {}
) =>
  execFileSync(program, args, {
    encoding: "utf-8",
    env: { PATH: [...bin, "/usr/bin", "/bin"].join(":") },
    input,
    timeout: childLimit,
    killSignal: "SIGKILL",
  });

const heredoc = (setup: string, mark: string) => {
  const body = new RegExp(
    `<<'${mark}'\\n(?<body>[\\s\\S]*?)\\n${mark}\\n`,
    "u"
  ).exec(setup)?.groups?.["body"];

  if (body === undefined) {
    throw new Error(`setup.sh writes no ${mark}`);
  }

  return body;
};

const installed = (setup: string, file: string) => {
  const found = new RegExp(
    `^[ \\t]*install -m (?<mode>[0-7]+) .*?\\b${file.replace(".", "\\.")} (?<to>/\\S+)$`,
    "mu"
  ).exec(setup)?.groups;

  if (found?.["mode"] === undefined || found["to"] === undefined) {
    throw new Error(`setup.sh doesn't install ${file}`);
  }

  return { mode: Number.parseInt(found["mode"], 8), to: found["to"] };
};

const startedByHook = async (setup: string, root: string) => {
  const record = path.join(root, "launched");

  ran("/bin/sh", ["-s", record], {
    input: [
      'launched="$1"',
      "pgrep() { return 1; }",
      "pkill() { return 0; }",
      "curl() { return 0; }",
      'su() { while [ "$1" != -c ]; do shift; done; eval "$2"; }',
      'setsid() { [ "$1" != -f ] || shift; printf "%s\\n" "$@" >"$launched"; }',
      heredoc(setup, "START"),
    ].join("\n"),
  });

  const said = await readFile(record, "utf-8");

  return said.trimEnd().split("\n");
};

const startedByPlist = (setup: string) => {
  const plist = heredoc(setup, "PLIST").replaceAll(/<!--[\s\S]*?-->/gu, "");

  const array =
    /<key>ProgramArguments<\/key>\s*<array>(?<items>[\s\S]*?)<\/array>/u.exec(
      plist
    )?.groups?.["items"] ?? "";

  return [...array.matchAll(/<string>(?<value>[^<]*)<\/string>/gu)].map(
    (item) => item.groups?.["value"] ?? ""
  );
};

const started = async (name: Recipe, setup: string, root: string) =>
  name === "ubuntu" ? await startedByHook(setup, root) : startedByPlist(setup);

const Served = Schema.Struct({
  args: Schema.String,
  timeout: Schema.String,
  key: Schema.String,
});

const decodeServed = Schema.decodeUnknownSync(Schema.fromJsonString(Served));

const launched = async (name: Recipe, agentEnv?: string) => {
  const setup = await setupOf(name);
  const root = await mkdtemp(path.join(tmpdir(), "clankerbox-recipe-"));
  const rooted = (file: string) => path.join(root, file);

  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serve = installed(setup, "serve.sh");
  const env = installed(setup, "agent.env");
  const launcher = await started(name, setup, root);

  await mkdir(path.dirname(rooted(serve.to)), { recursive: true });
  await copyFile(recipeFile(name, "serve.sh"), rooted(serve.to));
  await chmod(rooted(serve.to), serve.mode);
  await mkdir(rooted("bin"));
  await writeFile(
    rooted("bin/sandbox-agent"),
    `#!/bin/sh\nprintf '{"args":"%s","timeout":"%s","key":"%s"}' "$*" "\${SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS-}" "\${ANTHROPIC_API_KEY-}"\n`,
    { mode: 0o755 }
  );

  if (agentEnv !== undefined) {
    await mkdir(path.dirname(rooted(env.to)), { recursive: true });
    await writeFile(rooted(env.to), agentEnv);
  }

  const [program = "", ...args] = launcher.map(rooted);

  return {
    launcher,
    installed: [serve.to, env.to],
    served: decodeServed(ran(program, args, { bin: [rooted("bin")] })),
  };
};

const runtimesOf = new Map<string, readonly RuntimeTraits[]>([
  ["agent.yaml", [presets.smolvm.traits, smolCloud]],
  ["agent-boat.yaml", [boat]],
  ["agent-mac.yaml", [presets.tart.traits]],
]);

const Gib = Schema.String.check(Schema.isPattern(/^\d+G$/u));

const TemplateFile = Schema.Struct({
  base: Schema.String,
  cpu: Schema.Int,
  ram: Gib,
  disk: Gib,
  setup: Schema.String,
});

const decodeTemplateFile = Schema.decodeUnknownSync(TemplateFile);

const gib = (written: string) => Number(written.slice(0, -1));

const sizesOf = async (file: string) => {
  const { cpu, ram, disk } = decodeTemplateFile(
    Yaml.parse(
      await readFile(new URL(`../recipes/${file}`, import.meta.url), "utf-8")
    )
  );

  return { cpu, ramMib: gib(ram) * mibPerGib, diskGib: gib(disk) };
};

describe("recipes", { timeout: testLimit }, () => {
  it("each recipe checks the agent's health where the provider's tunnel reaches it", async () => {
    for (const name of recipes) {
      await expect(setupOf(name), name).resolves.toContain(
        `http://127.0.0.1:${agentPort}${healthPath}`
      );
    }
  });

  it.each(recipes)(
    "the %s recipe's launcher runs the serve.sh its setup installs, with the agent.env it installs",
    async (name) => {
      const { launcher, installed: files } = await launched(name);

      expect(launcher).toStrictEqual(files);
    }
  );

  it.each(recipes)(
    "the %s recipe's server waits a day for an agent's answer, unless agent.env says otherwise",
    async (name) => {
      await expect(launched(name)).resolves.toMatchObject({
        served: {
          args: "server --no-token --no-telemetry",
          timeout: "86400000",
          key: "",
        },
      });

      await expect(
        launched(
          name,
          "ANTHROPIC_API_KEY=sk-ant-test\nSANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=5000\n"
        )
      ).resolves.toMatchObject({
        served: {
          args: "server --no-token --no-telemetry",
          timeout: "5000",
          key: "sk-ant-test",
        },
      });
    }
  );

  it("each template file asks sizes every runtime it is for gives", async () => {
    const listed = await readdir(new URL("../recipes", import.meta.url));
    const files = listed.filter((file) => file.endsWith(".yaml")).toSorted();

    expect(files).toStrictEqual([...runtimesOf.keys()].toSorted());

    for (const file of files) {
      const sizes = await sizesOf(file);

      for (const traits of runtimesOf.get(file) ?? []) {
        expect(fitted(traits, sizes), `${file} on ${traits.runtime}`).toBe(
          true
        );
      }
    }
  });
});

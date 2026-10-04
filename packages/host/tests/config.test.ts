import { writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, type Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

const image = "ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

afterEach(() => removeScratch(owned));

const config = {
  id: "linux",
  runtime: "smolvm",
  listen: { address: "100.95.240.37", port: 8484 },
  stateDir: "state",
  bases: { ubuntu: image },
  smolvm: { prefix: "/opt/smolvm/1.22.2", publishAddress: "100.95.240.37" },
};

const load = async (contents: Schema.Json) => {
  const file = join(await scratch(owned), "host.json");

  await writeFile(file, JSON.stringify(contents));

  return { file, loaded: loadConfig(file).pipe(Effect.provide(NodeServices.layer)) };
};

test("a host config resolves its state dir against its own directory and defaults the RAM budget", async () => {
  const { file, loaded } = await load(config);
  const host = await Effect.runPromise(loaded);

  expect(host).toEqual({
    id: "linux",
    runtime: "smolvm",
    listen: { address: "100.95.240.37", port: 8484 },
    stateDir: join(file, "..", "state"),
    bases: new Map([["ubuntu", image]]),
    smolvm: {
      prefix: "/opt/smolvm/1.22.2",
      publishAddress: "100.95.240.37",
      ramBudgetMib: Math.floor(totalmem() / 1024 / 1024) - 2048,
    },
  });
});

test("a set RAM budget is kept, even above physical RAM", async () => {
  const { loaded } = await load({
    ...config,
    smolvm: { ...config.smolvm, ramBudgetMib: 1_000_000 },
  });

  expect((await Effect.runPromise(loaded)).smolvm.ramBudgetMib).toBe(1_000_000);
});

test("a host listens and publishes only on a tailnet or loopback address", async () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "::1", "100.64.0.1", "fd7a:115c:a1e0::5"]) {
    const { loaded } = await load({ ...config, listen: { address, port: 8484 } });

    await expect(Effect.runPromise(loaded), address).resolves.toMatchObject({
      listen: { address },
    });
  }

  for (const address of [
    "0.0.0.0",
    "::",
    "37.27.63.112",
    "192.168.1.2",
    "linux.tailnet",
    "100.128.0.1",
  ]) {
    const listening = await load({ ...config, listen: { address, port: 8484 } });

    const publishing = await load({
      ...config,
      smolvm: { ...config.smolvm, publishAddress: address },
    });

    for (const { loaded } of [listening, publishing]) {
      const error = await Effect.runPromise(Effect.flip(loaded));

      expect(error._tag, address).toBe("Invalid");
      expect(error.message, address).toContain("tailnet address");
    }
  }
});

test("an unknown key, another runtime or a bad host ID is Invalid", async () => {
  for (const contents of [
    { ...config, labels: [] },
    { ...config, runtime: "tart" },
    { ...config, id: "Linux" },
    { ...config, smolvm: { ...config.smolvm, ramBudgetMib: 0 } },
  ]) {
    const { loaded } = await load(contents);

    expect((await Effect.runPromise(Effect.flip(loaded)))._tag).toBe("Invalid");
  }
});

test("a missing config file is Invalid, naming it", async () => {
  const missing = join(await scratch(owned), "nope.json");

  const error = await Effect.runPromise(
    Effect.flip(loadConfig(missing)).pipe(Effect.provide(NodeServices.layer)),
  );

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain(missing);
});

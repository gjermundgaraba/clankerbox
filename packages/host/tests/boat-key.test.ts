/** The boat host's SSH key, generated in a scratch state dir with the real `ssh-keygen`. */
import { stat } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { keyFile, sshKey } from "../src/boat-key.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

afterEach(() => removeScratch(owned));

const load = (stateDir: string) =>
  Effect.runPromise(sshKey(stateDir).pipe(Effect.provide(NodeServices.layer)));

test("the host generates its ed25519 key once, private to it, and keeps it", async () => {
  const stateDir = await scratch(owned);

  const first = await load(stateDir);

  expect(first.file).toBe(keyFile(stateDir));
  expect(first.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ clankerbox-boat$/u);
  expect((await stat(first.file)).mode & 0o777).toBe(0o600);

  const again = await load(stateDir);

  expect(again).toEqual(first);
});

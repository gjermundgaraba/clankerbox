import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";

import { loadProfile, Profile, specRequest } from "../src/index.ts";
import { scratch, write } from "./files.ts";
import { operatorKey } from "./keys.ts";

const decode = Schema.decodeUnknownResult(Profile);

const sizes = { base: "ubuntu", cpu: 2, ramMib: 4096, diskGib: 20 };

const keys = `${operatorKey}\n`;

const loadError = (file: string) => Effect.flip(loadProfile(file));

const refusal = (...args: Parameters<typeof specRequest>) =>
  Effect.flip(specRequest(...args));

describe("profile", () => {
  layer(NodeServices.layer)((it) => {
    it("a profile decodes with or without setup", () => {
      expect(decode(sizes)._tag).toBe("Success");
      expect(
        decode({
          ...sizes,
          setup: { path: "recipe", timeoutSeconds: 600 },
          host: "linux",
        })._tag
      ).toBe("Success");
    });

    it("a profile's setup needs its path, and may leave its timeout to the host", () => {
      expect(decode({ ...sizes, setup: { path: "recipe" } })._tag).toBe(
        "Success"
      );
      expect(decode({ ...sizes, setup: { timeoutSeconds: 600 } })._tag).toBe(
        "Failure"
      );
    });

    it("a profile's host is a host ID", () => {
      expect(decode({ ...sizes, host: "li_nux" })._tag).toBe("Failure");
    });

    it.effect(
      "a profile file's name is the label, and its setup path is resolved against the file",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;

          yield* write(
            path.join(dir, "dev.json"),
            JSON.stringify({
              ...sizes,
              setup: { path: "scripts/dev.sh", timeoutSeconds: 300 },
              host: "mac",
            })
          );

          const profile = yield* loadProfile(path.join(dir, "dev.json"));

          expect(profile).toStrictEqual({
            ...sizes,
            setup: {
              path: path.join(dir, "scripts", "dev.sh"),
              timeoutSeconds: 300,
            },
            host: "mac",
            label: "dev",
          });
        })
    );

    it.effect("a profile without setup has no setup", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* write(path.join(dir, "bare.json"), JSON.stringify(sizes));

        expect(yield* loadProfile(path.join(dir, "bare.json"))).toStrictEqual({
          ...sizes,
          label: "bare",
        });
      })
    );

    it.effect(
      "a profile without a base takes the create's, and a create with neither is refused, naming it as told",
      () =>
        Effect.gen(function* () {
          const { base: _, ...unbased } = sizes;
          const profile = { ...unbased, label: "orb" };
          const names = new Map<PropertyKey, string>([["base", "--base"]]);

          expect(decode(unbased)._tag).toBe("Success");
          expect(
            yield* specRequest("create", profile, {
              base: "registry.example/orb:1",
            })
          ).toStrictEqual({
            spec: {
              ...unbased,
              base: "registry.example/orb:1",
              profile: "orb",
            },
            host: undefined,
          });
          expect((yield* refusal("create", profile, {}, names)).message).toBe(
            "create: --base: missing"
          );
        })
    );

    it.effect(
      "a profile with an unknown key, or setup without its path, is Invalid",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;

          yield* write(
            path.join(dir, "typo.json"),
            JSON.stringify({ ...sizes, ram: 4096 })
          );
          yield* write(
            path.join(dir, "half.json"),
            JSON.stringify({ ...sizes, setup: { timeoutSeconds: 60 } })
          );

          expect((yield* loadError(path.join(dir, "typo.json")))._tag).toBe(
            "Invalid"
          );
          expect((yield* loadError(path.join(dir, "half.json")))._tag).toBe(
            "Invalid"
          );
        })
    );

    it.effect(
      "a create of a profile asks for its fields, its setup read with its timeout and authorized keys, and its host",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const authorizedKeys = path.join(dir, "id.pub");

          yield* write(path.join(dir, "setup.sh"), "#!/bin/sh\necho hi\n");
          yield* write(authorizedKeys, keys);

          const profile = {
            ...sizes,
            label: "dev",
            setup: { path: path.join(dir, "setup.sh"), timeoutSeconds: 600 },
            host: "linux",
          };

          expect(
            yield* specRequest("create", profile, { authorizedKeys })
          ).toStrictEqual({
            spec: {
              ...sizes,
              profile: "dev",
              setup: {
                script: "#!/bin/sh\necho hi\n",
                timeoutSeconds: 600,
                authorizedKeys: keys,
              },
            },
            host: "linux",
          });

          expect(
            yield* specRequest("create", profile, {
              cpu: 4,
              setupTimeoutSeconds: 60,
              host: "mac",
              authorizedKeys,
            })
          ).toStrictEqual({
            spec: {
              ...sizes,
              cpu: 4,
              profile: "dev",
              setup: {
                script: "#!/bin/sh\necho hi\n",
                timeoutSeconds: 60,
                authorizedKeys: keys,
              },
            },
            host: "mac",
          });
        })
    );

    it.effect(
      "a create refuses a field nobody gives, a setup timeout with no setup, and a setup with no authorized keys, naming each as told",
      () =>
        Effect.gen(function* () {
          const names = new Map<PropertyKey, string>([
            ["cpu", "--cpu"],
            ["setupTimeoutSeconds", "--setup-timeout"],
            ["authorizedKeys", "the config's authorizedKeys"],
          ]);

          const missing = yield* refusal(
            "create",
            undefined,
            { base: "ubuntu" },
            names
          );

          const untimed = yield* refusal(
            "create",
            { ...sizes, label: "dev" },
            { setupTimeoutSeconds: 60 },
            names
          );

          const keyless = yield* refusal(
            "create",
            { ...sizes, label: "dev", setup: { path: "/nowhere/setup.sh" } },
            {},
            names
          );

          expect(missing.message).toBe(
            "create: --cpu: missing; ramMib: missing; diskGib: missing"
          );
          expect(untimed.message).toBe(
            "create: --setup-timeout needs a setup to time"
          );
          expect(keyless.message).toBe(
            "create: a setup needs the config's authorizedKeys, the public keys the host installs for the login user after it"
          );
        })
    );
  });
});

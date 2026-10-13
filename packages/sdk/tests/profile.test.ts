import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { loadProfile, Profile, specRequest } from "../src/index.ts";
import { scratch, write } from "./files.ts";

const decode = Schema.decodeUnknownResult(Profile);

const sizes = { base: "ubuntu", cpu: 2, ramMib: 4096, diskGib: 20 };

it("a profile decodes with or without setup", () => {
  expect(decode(sizes)._tag).toBe("Success");
  expect(
    decode({ ...sizes, setup: { path: "recipe", timeoutSeconds: 600 }, host: "linux" })._tag,
  ).toBe("Success");
});

it("a profile's setup needs its path, and may leave its timeout to the host", () => {
  expect(decode({ ...sizes, setup: { path: "recipe" } })._tag).toBe("Success");
  expect(decode({ ...sizes, setup: { timeoutSeconds: 600 } })._tag).toBe("Failure");
});

it("a profile's host is a host ID", () => {
  expect(decode({ ...sizes, host: "li_nux" })._tag).toBe("Failure");
});

const loadError = (file: string) => Effect.flip(loadProfile(file));

const refusal = (...args: Parameters<typeof specRequest>) => Effect.flip(specRequest(...args));

layer(NodeServices.layer)((it) => {
  it.effect(
    "a profile file's name is the label, and its setup path is resolved against the file",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* write(
          join(dir, "dev.json"),
          JSON.stringify({
            ...sizes,
            setup: { path: "scripts/dev.sh", timeoutSeconds: 300 },
            host: "mac",
          }),
        );

        const profile = yield* loadProfile(join(dir, "dev.json"));

        expect(profile).toEqual({
          ...sizes,
          setup: { path: join(dir, "scripts", "dev.sh"), timeoutSeconds: 300 },
          host: "mac",
          label: "dev",
        });
      }),
  );

  it.effect("a profile without setup has no setup", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* write(join(dir, "bare.json"), JSON.stringify(sizes));

      expect(yield* loadProfile(join(dir, "bare.json"))).toEqual({ ...sizes, label: "bare" });
    }),
  );

  it.effect("a profile with an unknown key, or setup without its path, is InvalidFile", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* write(join(dir, "typo.json"), JSON.stringify({ ...sizes, ram: 4096 }));
      yield* write(
        join(dir, "half.json"),
        JSON.stringify({ ...sizes, setup: { timeoutSeconds: 60 } }),
      );

      expect((yield* loadError(join(dir, "typo.json")))._tag).toBe("InvalidFile");
      expect((yield* loadError(join(dir, "half.json")))._tag).toBe("InvalidFile");
    }),
  );

  it.effect(
    "a create of a profile asks for its fields, its setup read with its timeout, and its host",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* write(join(dir, "setup.sh"), "#!/bin/sh\necho hi\n");

        const profile = {
          ...sizes,
          label: "dev",
          setup: { path: join(dir, "setup.sh"), timeoutSeconds: 600 },
          host: "linux",
        };

        expect(yield* specRequest("create", profile, {})).toEqual({
          spec: {
            ...sizes,
            profile: "dev",
            setup: { script: "#!/bin/sh\necho hi\n", timeoutSeconds: 600 },
          },
          host: "linux",
        });

        expect(
          yield* specRequest("create", profile, { cpu: 4, setupTimeoutSeconds: 60, host: "mac" }),
        ).toEqual({
          spec: {
            ...sizes,
            cpu: 4,
            profile: "dev",
            setup: { script: "#!/bin/sh\necho hi\n", timeoutSeconds: 60 },
          },
          host: "mac",
        });
      }),
  );

  it.effect(
    "a create refuses a field nobody gives, and a setup timeout with no setup, naming each as told",
    () =>
      Effect.gen(function* () {
        const names = new Map<PropertyKey, string>([
          ["cpu", "--cpu"],
          ["setupTimeoutSeconds", "--setup-timeout"],
        ]);

        const missing = yield* refusal("create", undefined, { base: "ubuntu" }, names);

        const untimed = yield* refusal(
          "create",
          { ...sizes, label: "dev" },
          { setupTimeoutSeconds: 60 },
          names,
        );

        expect(missing.message).toBe("create: --cpu: missing; ramMib: missing; diskGib: missing");
        expect(untimed.message).toBe("create: --setup-timeout needs a setup to time");
      }),
  );
});

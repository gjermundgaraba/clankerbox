import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Capacity, Superseded } from "@gjermundgaraba/clankerbox-sdk";
import { elapsing } from "@gjermundgaraba/clankerbox-sdk/testing/clock";
import {
  mkdir,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { StubHost } from "@gjermundgaraba/clankerbox-sdk/testing/stub-host";
import { Effect, Queue } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  hostIn,
  sizes,
  writeConfig,
} from "./support.ts";
import type { CliOptions } from "./support.ts";

const stubs: StubHost[] = [];

const host = hostIn(stubs);

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "a list exits 1 when every host failed, still naming each one",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux", "mac"]);

        for (const command of [
          ["machines"],
          ["hosts"],
          ["checkpoint", "list"],
        ]) {
          const { code, stdout, stderr } = yield* cli(
            [...command, "--config", config],
            {
              endpoints: [
                ["linux", "down"],
                ["mac", "down"],
              ],
            }
          );

          const json = yield* cli([...command, "--json", "--config", config], {
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
      })
  );

  it.effect(
    "with --json an error prints {error: {message, tag, retryable}} and exits 1",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);

        const { code, stdout } = yield* cli(
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
          { endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]] }
        );

        const { error } = decodeJsonError(stdout);

        expect(code).toBe(1);
        expect(error.tag).toBe("NotOffered");
        expect(error.retryable).toBe(false);
        expect(error.message).toContain("linux offers ubuntu");
      })
  );

  it.effect(
    "with --json a usage error is effect/cli's usual output, and exits 1",
    () =>
      Effect.gen(function* () {
        const missing = yield* cli(["start", "--json"]);

        const malformed = yield* cli([
          "create",
          "dev",
          "--json",
          ...sizes.slice(0, 2),
          "--cpu",
          "x",
        ]);

        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("machine");
        expect(malformed.code).toBe(1);
        expect(malformed.stderr).toContain("--cpu");
      })
  );

  it.effect("with --json, --help still prints the help", () =>
    Effect.gen(function* () {
      const { code, stdout } = yield* cli(["machines", "--help", "--json"]);

      expect(code).toBe(0);
      expect(stdout).toContain("clankerbox machines");
    })
  );

  it.effect("a retryable error says so in --json, with where it was met", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const { code, stdout } = yield* cli(
        ["create", "dev", ...sizes, "--json", "--config", config],
        {
          endpoints: [
            [
              "linux",
              host({
                id: "linux",
                bases: ["ubuntu"],
                create: () =>
                  Effect.fail(new Capacity({ message: "RAM budget is full" })),
              }),
            ],
          ],
        }
      );

      expect(code).toBe(1);
      expect(decodeJsonError(stdout).error).toStrictEqual({
        message: "RAM budget is full",
        tag: "Capacity",
        retryable: true,
        host: "linux",
        action: "createMachine",
        id: "linux_dev",
        made: "linux_dev",
      });
    })
  );

  it.effect(
    "a Superseded error's later request is in --json, and it isn't retryable",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);

        const replaced = host({
          id: "linux",
          bases: ["ubuntu"],
          create: () =>
            Effect.fail(
              new Superseded({
                by: "deleted",
                message: "machine linux_dev was deleted first",
              })
            ),
        });

        const { code, stdout } = yield* cli(
          ["create", "dev", ...sizes, "--json", "--config", config],
          {
            endpoints: [["linux", replaced]],
          }
        );

        expect(code).toBe(1);
        expect(decodeJsonError(stdout).error).toMatchObject({
          tag: "Superseded",
          by: "deleted",
          retryable: false,
          id: "linux_dev",
        });
      })
  );

  it.effect("without --json an error goes to stderr with its tag", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const { code, stdout, stderr } = yield* cli(
        ["start", "mac_dev", "--config", config],
        {
          endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
        }
      );

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Invalid");
    })
  );

  it.effect(
    "--timeout stops waiting, says the action may have run, and exits 1",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const arrived = yield* Queue.unbounded<undefined>();

        const linux = host({
          id: "linux",
          bases: ["ubuntu"],
          create: () =>
            Effect.andThen(Queue.offer(arrived, undefined), Effect.never),
        });

        const endpoints = [["linux", linux]] as const;

        const text = yield* elapsing(
          "1 second",
          cli(
            ["create", "dev", ...sizes, "--timeout", "1s", "--config", config],
            { endpoints }
          ),
          Queue.take(arrived)
        );

        const json = yield* elapsing(
          "1 second",
          cli(
            [
              "create",
              "slow",
              ...sizes,
              "--timeout",
              "1s",
              "--json",
              "--config",
              config,
            ],
            {
              endpoints,
            }
          ),
          Queue.take(arrived)
        );

        expect(text.code).toBe(1);
        expect(text.stderr).toContain("may have run: read linux_dev to see");
        expect(json.code).toBe(1);
        expect(decodeJsonError(json.stdout).error).toMatchObject({
          tag: "Unavailable",
          retryable: false,
          readOnly: false,
          id: "linux_slow",
        });
        expect(linux.creates).toHaveLength(2);
      })
  );

  it.effect("a read takes no --timeout", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { code } = yield* cli(
        ["machines", "--timeout", "1s", "--config", config],
        {
          endpoints: [["linux", linux]],
        }
      );

      expect(code).toBe(1);
      expect(linux.calls).toStrictEqual([]);
    })
  );

  it.effect(
    "a list with nothing in it prints no table and says so on stderr",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux", "mac"], "profiles");

        yield* mkdir(path.join(dir, "profiles"));

        const endpoints: CliOptions["endpoints"] = [
          ["linux", host({ id: "linux", bases: ["ubuntu"] })],
          ["mac", "down"],
        ];

        const machines = yield* cli(["machines", "--config", config], {
          endpoints,
        });

        const json = yield* cli(["machines", "--json", "--config", config], {
          endpoints,
        });

        const profiles = yield* cli(["profiles", "--config", config]);

        expect(machines).toMatchObject({ code: 0, stdout: "" });
        expect(machines.stderr.split("\n")[0]).toBe(
          "clankerbox: no machines to list"
        );
        expect(machines.stderr).toContain("Unavailable: host mac");
        expect(JSON.parse(json.stdout)).toMatchObject({ machines: [] });
        expect(profiles).toMatchObject({
          code: 0,
          stdout: "",
          stderr: `clankerbox: no profiles in ${path.join(dir, "profiles")}`,
        });
      })
  );

  it.effect("a host URL with a trailing slash still reaches its routes", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = path.join(dir, "config.json");

      yield* write(
        config,
        JSON.stringify({ hosts: [{ id: "linux", url: "http://linux.test/" }] })
      );

      const { code, stdout } = yield* cli(["hosts", "--config", config], {
        endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
      });

      expect(code).toBe(0);
      expect(stdout).toContain("ubuntu");
    })
  );
});

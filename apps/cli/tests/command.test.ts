import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, layer } from "@effect/vitest";
import { Capacity, ScriptFailed } from "@gjermundgaraba/clankerbox-sdk";
import { ticking } from "@gjermundgaraba/clankerbox-sdk/testing/clock";
import { write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { machine } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  serverIn,
  serverUrl,
  sizes,
  writeConfig,
} from "./support.ts";

const stubs: StubServer[] = [];

const server = serverIn(stubs);

describe("commands", () => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  layer(NodeServices.layer)((it) => {
    it.effect(
      "a read exits 1 when the control plane doesn't answer, saying which one and printing no list",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          for (const command of [
            ["machines"],
            ["hosts"],
            ["capacity"],
            ["checkpoint", "list"],
          ]) {
            const { code, stdout, stderr } = yield* cli(
              [...command, "--config", config],
              { server: "down" }
            );

            const json = yield* cli(
              [...command, "--json", "--config", config],
              {
                server: "down",
              }
            );

            expect(code, command.join(" ")).toBe(1);
            expect(stdout).toBe("");
            expect(stderr).not.toContain("clankerbox: no ");
            expect(stderr).toContain(serverUrl);
            expect(json.code, command.join(" ")).toBe(1);
            expect(decodeJsonError(json.stdout).error).toMatchObject({
              tag: "Unavailable",
              readOnly: true,
              retryable: true,
            });
          }
        })
    );

    it.effect(
      "with --json an error prints {error: {message, tag, retryable}} and exits 1",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

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
            {
              server: server({ bases: ["macos"] }),
            }
          );

          const { error } = decodeJsonError(stdout);

          expect(code).toBe(1);
          expect(error.tag).toBe("NotOffered");
          expect(error.retryable).toBe(false);
          expect(error.message).toContain("offers macos");
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

    it.effect(
      "a retryable error says so in --json, with where it was met",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const stub = server();

          stub.script("dev", [
            {
              phase: "failed",
              state: "missing",
              error: new Capacity({ message: "RAM budget is full" }),
            },
          ]);

          const { code, stdout } = yield* cli(
            ["create", "dev", ...sizes, "--json", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error).toStrictEqual({
            message: "RAM budget is full",
            tag: "Capacity",
            retryable: true,
            action: "createMachine",
            id: "dev",
            made: "dev",
          });
        })
    );

    it.effect(
      "a machine that rests failed fails the command that waited on it, with the row's error and what it made",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          stub.script("dev", [
            {
              phase: "failed",
              state: "missing",
              error: new ScriptFailed({
                message: "setup exited 7",
                script: "setup",
              }),
            },
          ]);

          const { code, stdout } = yield* cli(
            ["create", "dev", ...sizes, "--json", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error).toMatchObject({
            tag: "ScriptFailed",
            message: "setup exited 7",
            action: "createMachine",
            id: "dev",
            made: "dev",
          });
        })
    );

    it.effect(
      "a Superseded error's later request is in --json, and it isn't retryable",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          stub.script("dev", ["gone"]);

          const { code, stdout } = yield* cli(
            ["create", "dev", ...sizes, "--json", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error).toMatchObject({
            tag: "Superseded",
            by: "deleted",
            retryable: false,
            id: "dev",
          });
        })
    );

    it.effect(
      "a stop that a later start overtook is Superseded by what the machine was then asked to be",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [{ desired: "running", phase: "settled" }]);

          const { code, stderr } = yield* cli(
            ["stop", "dev", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(stderr).toContain("Superseded");
          expect(stderr).toContain("running");
        })
    );

    it.effect(
      "a machine whose host stays unreachable ends the command as a long outage does, saying the request is saved",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const stub = server({
            machines: [machine("dev", { state: "unknown" })],
          });

          stub.script("dev", ["waiting"]);

          const { code, stdout } = yield* ticking(
            cli(["start", "dev", "--json", "--config", config], {
              server: stub,
            })
          );

          const { error } = decodeJsonError(stdout);

          expect(code).toBe(1);
          expect(error).toMatchObject({
            tag: "Unavailable",
            readOnly: false,
            retryable: false,
          });
          expect(error.message).toContain("the request is saved");
        })
    );

    it.effect("without --json an error goes to stderr with its tag", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const { code, stdout, stderr } = yield* cli(
          ["start", "dev", "--config", config],
          { server: server() }
        );

        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("NotFound");
      })
    );

    it.effect(
      "a mutation whose reply is lost says the action may have run, and to read what it made",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const { code, stderr } = yield* cli(
            ["create", "dev", ...sizes, "--config", config],
            { server: { lost: stub } }
          );

          expect(code).toBe(1);
          expect(stderr).toContain("may have run: read dev to see");
          expect(stub.held()).toStrictEqual(["dev"]);
        })
    );

    it.effect(
      "--no-wait answers once the request is recorded, and reads nothing after",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const made = yield* cli(
            [
              "create",
              "dev",
              ...sizes,
              "--no-wait",
              "--json",
              "--config",
              config,
            ],
            { server: stub }
          );

          const removed = yield* cli(
            ["delete", "dev", "--no-wait", "--config", config],
            { server: stub }
          );

          expect(made.code).toBe(0);
          expect(JSON.parse(made.stdout)).toMatchObject({
            id: "dev",
            phase: "observing",
          });
          expect(removed).toMatchObject({ code: 0, stdout: "dev" });
          expect(stub.calls).toStrictEqual([
            "machine.create",
            "machine.delete",
          ]);
        })
    );

    it.effect("a read takes no --timeout", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const stub = server();

        const { code } = yield* cli(
          ["machines", "--timeout", "1s", "--config", config],
          { server: stub }
        );

        expect(code).toBe(1);
        expect(stub.calls).toStrictEqual([]);
      })
    );

    it.effect(
      "a list with nothing in it prints no table and says so on stderr",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const machines = yield* cli(["machines", "--config", config], {
            server: stub,
          });

          const json = yield* cli(["machines", "--json", "--config", config], {
            server: stub,
          });

          const templates = yield* cli(
            ["template", "list", "--config", config],
            {
              server: stub,
            }
          );

          expect(machines).toMatchObject({
            code: 0,
            stdout: "",
            stderr: "clankerbox: no machines to list",
          });
          expect(JSON.parse(json.stdout)).toStrictEqual({ machines: [] });
          expect(templates).toMatchObject({
            code: 0,
            stdout: "",
            stderr: "clankerbox: no templates to list",
          });
        })
    );

    it.effect(
      "a server URL with a trailing slash still reaches its routes",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = path.join(dir, "config.json");

          yield* write(config, JSON.stringify({ server: `${serverUrl}/` }));

          const { code, stdout } = yield* cli(["hosts", "--config", config], {
            server: server(),
          });

          expect(code).toBe(0);
          expect(stdout).toContain("ubuntu");
        })
    );
  });

  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "--timeout stops the wait, says the request is saved, and exits 1",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          stub.script("dev", ["creating"]);
          stub.script("slow", ["creating"]);

          const [text, json] = yield* Effect.all(
            [
              cli(
                [
                  "create",
                  "dev",
                  ...sizes,
                  "--timeout",
                  "1s",
                  "--config",
                  config,
                ],
                { server: stub }
              ),
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
                { server: stub }
              ),
            ],
            { concurrency: "unbounded" }
          );

          expect(text.code).toBe(1);
          expect(text.stderr).toContain(
            "dev didn't rest within 1s; the request is saved"
          );
          expect(json.code).toBe(1);
          expect(decodeJsonError(json.stdout).error).toMatchObject({
            tag: "Unavailable",
            retryable: false,
            readOnly: false,
            id: "slow",
          });
          expect(stub.creates).toHaveLength(2);
        })
    );
  });
});

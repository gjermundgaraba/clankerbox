import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Handle, Operation, Report } from "@clankerbox/host-contract";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Stream } from "effect";
import { expect } from "vite-plus/test";

import { hostLayer } from "../../src/composition/host.ts";
import { Operations } from "../../src/operations.ts";
import * as Box from "../../src/platform/box.ts";
import * as Smolvm from "../../src/platform/smolvm/smolvm.ts";
import { Runtime, sightingIn } from "../../src/runtime.ts";
import type { Target } from "../../src/runtime.ts";
import { hostConfig, loopbackServer, suitePorts } from "../support.ts";

const prefix = process.env["SMOLVM_PREFIX"] ?? "";

const live = process.env["CLANKERBOX_LIVE"] === "1" && prefix !== "";

const image =
  "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

const hostId = "smolvm-live";

const sized = { cpu: 2, ramMib: 2048, diskGib: 10 };

const instanceOf = (name: string) =>
  Buffer.from(name).toString("hex").padEnd(32, "0").slice(0, 32);

const refOf = (name: string, handle?: Handle, sizes = sized) => ({
  name,
  instance: instanceOf(name),
  ...sizes,
  ...(handle === undefined ? {} : { handle }),
});

const markers = "/root/marker /workspace/marker";

const onHost = Effect.gen(function* () {
  const state = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cbx-smolvm-"))),
    (folder) =>
      Effect.sync(() => {
        rmSync(folder, { recursive: true, force: true });
      })
  );

  const config = {
    ...hostConfig(state, suitePorts.liveSmolvm, hostId),
    bases: new Map([["ubuntu", image]]),
  };

  const context = yield* Layer.build(
    hostLayer(config, Smolvm.layer({ prefix }, config), loopbackServer()).pipe(
      Layer.provide(Box.layer),
      Layer.provide(NodeHttpClient.layerNodeHttp),
      Layer.provide(NodeServices.layer)
    )
  );

  return {
    runtime: Context.get(context, Runtime),
    operations: Context.get(context, Operations),
  };
});

describe.runIf(live)("the smolvm runtime on a host, live", () => {
  it.live(
    "makes, forks running and stopped, grows live, captures running and stopped, and restores a machine, each copy holding its source's /root and /workspace",
    () =>
      Effect.gen(function* () {
        const { runtime, operations } = yield* onHost;
        const pinned = runtime.pin === undefined ? {} : { pin: runtime.pin };
        const held = new Map<string, Handle>();
        const kept = new Map<string, Handle>();
        let sequence = 0;

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const [name, handle] of kept) {
              yield* Effect.ignore(
                runtime.deleteCheckpoint({
                  name,
                  instance: instanceOf(name),
                  handle,
                })
              );
            }

            for (const [name, handle] of held) {
              yield* Effect.ignore(
                runtime.delete(
                  { name, instance: instanceOf(name), handle },
                  new Set()
                )
              );
            }
          })
        );

        const others = () =>
          [...held].map(([name, handle]) => refOf(name, handle));

        const step = (name: string, body: Operation["step"]) =>
          Effect.gen(function* () {
            sequence += 1;

            const id = `${name}-${sequence}`;

            const resource =
              body._tag === "capture" || body._tag === "deleteCheckpoint"
                ? "checkpoint"
                : "machine";

            yield* operations.run({
              id,
              boot: operations.boot,
              scope: { resource, name },
              sequence,
              step: body,
            });

            const report: Report = yield* operations
              .wait(id)
              .pipe(
                Effect.repeat({ until: ({ status }) => status !== "running" }),
                Effect.timeout(Duration.minutes(15))
              );

            expect(
              report.status,
              `${body._tag} ${name}: ${report.error?.message ?? ""}`
            ).toBe("done");

            return report;
          }).pipe(Effect.orDie);

        const target = (name: string): Target => {
          const handle = held.get(name);

          if (handle === undefined) {
            throw new Error(`machine ${name} was never made`);
          }

          return { name, instance: instanceOf(name), handle };
        };

        const shell = (name: string, script: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const execution = yield* runtime.exec(target(name), {
                argv: ["sh", "-c", script],
              });

              const output = yield* Stream.mkString(
                Stream.decodeText(execution.output)
              );

              expect(
                yield* execution.exitCode,
                `${name}: sh -c ${script}: ${output}`
              ).toBe(0);

              return output;
            })
          ).pipe(Effect.orDie);

        const stateOf = (name: string) =>
          Effect.map(
            Effect.orDie(runtime.observe([target(name)])),
            (observed) => sightingIn(observed, { name }).state
          );

        const made = (
          name: string,
          source: Extract<Operation["step"], { _tag: "make" }>["source"]
        ) =>
          Effect.gen(function* () {
            const report = yield* step(name, {
              _tag: "make",
              machine: refOf(name),
              source,
              taken: [],
              machines: others(),
            });

            const handle = yield* Effect.orDie(
              Effect.fromNullishOr(report.outcome.handle)
            );

            held.set(name, handle);

            if (report.outcome.prepared !== true) {
              yield* step(name, {
                _tag: "start",
                machine: refOf(name, handle),
                keep: [],
                machines: others(),
              });
            }

            expect(yield* stateOf(name)).toBe("running");
          });

        const holdsMarkers = (name: string) =>
          Effect.map(shell(name, `cat ${markers}`), (output) => {
            expect(output, `${name} holds its source's files`).toBe(
              "root-marker\nworkspace-marker\n"
            );
          });

        const grown = { ...sized, ramMib: sized.ramMib + 128 };

        const captured = (name: string, machine: string) =>
          Effect.gen(function* () {
            const report = yield* step(name, {
              _tag: "capture",
              machine: refOf(machine, held.get(machine), grown),
              checkpoint: refOf(name, undefined, grown),
              ...pinned,
            });

            kept.set(
              name,
              yield* Effect.orDie(Effect.fromNullishOr(report.outcome.handle))
            );
          });

        yield* made("dev", { _tag: "base", base: "ubuntu" });
        yield* shell(
          "dev",
          "echo root-marker > /root/marker && mkdir -p /workspace && echo workspace-marker > /workspace/marker && sync"
        );

        yield* made("fork-running", {
          _tag: "machine",
          machine: refOf("dev", held.get("dev")),
          ...pinned,
        });
        yield* holdsMarkers("fork-running");

        yield* step("dev", {
          _tag: "resize",
          machine: refOf("dev", held.get("dev")),
          to: { ramMib: grown.ramMib },
          machines: others(),
        });

        const sizes = yield* Effect.orDie(runtime.sizes(target("dev")));

        expect(sizes.ramMib, "the live grow's RAM").toBe(grown.ramMib);

        yield* captured("snap-running", "dev");

        yield* step("dev", {
          _tag: "stop",
          machine: refOf("dev", held.get("dev"), grown),
        });
        expect(yield* stateOf("dev")).toBe("stopped");

        yield* made("fork-stopped", {
          _tag: "machine",
          machine: refOf("dev", held.get("dev"), grown),
        });
        yield* holdsMarkers("fork-stopped");

        yield* captured("snap-stopped", "dev");

        for (const checkpoint of ["snap-stopped", "snap-running"]) {
          const copy = `from-${checkpoint}`;

          yield* made(copy, {
            _tag: "checkpoint",
            checkpoint: refOf(checkpoint, kept.get(checkpoint), grown),
            ...pinned,
          });
          yield* holdsMarkers(copy);
        }

        expect(yield* stateOf("dev"), "the stopped source never booted").toBe(
          "stopped"
        );

        for (const name of kept.keys()) {
          yield* step(name, {
            _tag: "deleteCheckpoint",
            checkpoint: refOf(name, kept.get(name), grown),
          });
          kept.delete(name);
        }

        for (const name of held.keys()) {
          yield* step(name, {
            _tag: "remove",
            machine: refOf(name, held.get(name)),
            keep: [],
          });
          expect(
            yield* Effect.orDie(runtime.find(target(name)))
          ).toBeUndefined();
          held.delete(name);
        }
      }).pipe(Effect.scoped),
    { timeout: 60 * 60 * 1000 }
  );
});

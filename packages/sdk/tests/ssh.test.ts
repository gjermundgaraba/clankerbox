import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  buildId,
  pinnedSsh,
  ScriptFailed,
  SshEndpoint,
  sshTarget,
  WrongState,
} from "../src/index.ts";
import type { Machine } from "../src/index.ts";
import { read } from "./files.ts";
import { machine } from "./stub-server.ts";

const login = { user: "user", host: "100.64.0.7", port: 10_022 };

const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@dev";

const reachable = machine("dev", { ssh: login, hostKey });

const knownHostsOption = "UserKnownHostsFile=";

const plain = ({ _tag, message, machine: id, state }: WrongState) => ({
  _tag,
  message,
  machine: id,
  state,
});

const knownHostsIn = (args: readonly string[]): string =>
  args
    .find((arg) => arg.startsWith(knownHostsOption))
    ?.slice(knownHostsOption.length) ?? "";

const notAddresses = ["example.com", "localhost", "100.64.0.7 ", ""];

layer(NodeServices.layer)((it) => {
  it.effect("a login whose host is not an IP address is no target", () =>
    Effect.gen(function* () {
      for (const host of notAddresses) {
        const refused = yield* Effect.flip(
          sshTarget(machine("dev", { ssh: { ...login, host }, hostKey }))
        );

        expect(plain(refused), host).toStrictEqual({
          _tag: "WrongState",
          message: `dev's SSH login names ${JSON.stringify(host)}, which is not an IP address`,
          machine: "dev",
          state: "running",
        });
      }

      for (const host of ["100.64.0.7", "fd7a:115c:a1e0::7", "::1"]) {
        expect(
          (yield* sshTarget(
            machine("dev", { ssh: { ...login, host }, hostKey })
          )).login.host
        ).toBe(host);
      }
    })
  );

  it.effect(
    "an SSH endpoint whose host is not an IP address doesn't decode",
    () =>
      Effect.sync(() => {
        for (const host of notAddresses) {
          expect(
            Exit.isFailure(
              Schema.decodeExit(SshEndpoint)({ host, port: 10_022 })
            ),
            host
          ).toBe(true);
        }

        expect(
          Schema.decodeExit(SshEndpoint)({
            host: "100.64.0.7",
            port: 10_022,
          })
        ).toStrictEqual(Exit.succeed({ host: "100.64.0.7", port: 10_022 }));
      })
  );

  it.effect(
    "a running, prepared machine is a target with its login and host key",
    () =>
      Effect.gen(function* () {
        expect(yield* sshTarget(reachable)).toStrictEqual({
          id: "dev",
          login,
          hostKey,
        });
      })
  );

  it.effect(
    "a machine without a login is no target, and says why: no host key on record, or a VM that doesn't run",
    () =>
      Effect.gen(function* () {
        const said: ReadonlyArray<readonly [Machine, WrongState]> = [
          [
            machine("dev", { state: "stopped", desired: "stopped", hostKey }),
            new WrongState({
              message:
                "dev has no SSH login (stopped): its VM doesn't run, so start it with clankerbox start dev",
              machine: "dev",
              state: "stopped",
            }),
          ],
          [
            machine("dev", { state: "stopped", desired: "stopped" }),
            new WrongState({
              message: `dev has no SSH login (stopped): its VM doesn't run, so start it with clankerbox start dev; its host has no SSH host key on record for it, as for a machine made from a base the host didn't prepare, so then reach it with clankerbox exec, or create it from a template`,
              machine: "dev",
              state: "stopped",
            }),
          ],
          [
            machine("dev", { state: "unknown", hostKey }),
            new WrongState({
              message: "dev has no SSH login (unknown): see clankerbox get dev",
              machine: "dev",
              state: "unknown",
            }),
          ],
          [
            machine("dev", {
              template: buildId("web", 1),
              state: "stopped",
              desired: "running",
              phase: "starting",
            }),
            new WrongState({
              message:
                "dev has no SSH login (stopped, wants running (starting)): its host has no SSH host key on record for it yet: a host reads one as it prepares a machine, and one made from a base only where its host prepares it; see clankerbox get dev",
              machine: "dev",
              state: "stopped, wants running (starting)",
            }),
          ],
          [
            machine("dev", { template: buildId("web", 1), phase: "failed" }),
            new WrongState({
              message:
                "dev has no SSH login (running (failed)): its host has no SSH host key on record for it; see clankerbox get dev",
              machine: "dev",
              state: "running (failed)",
            }),
          ],
          [
            machine("dev", {
              phase: "failed",
              ssh: login,
              error: new ScriptFailed({
                message: "setup exited 1",
                script: "setup",
              }),
            }),
            new WrongState({
              message:
                "dev has no SSH login (running (failed)): its host has no SSH host key on record for it, as for a machine made from a base the host didn't prepare; reach it with clankerbox exec, or create it from a template",
              machine: "dev",
              state: "running (failed)",
            }),
          ],
          [
            machine("dev", {
              state: "stopped",
              desired: "running",
              phase: "starting",
            }),
            new WrongState({
              message:
                "dev has no SSH login (stopped, wants running (starting)): its host has no SSH host key on record for it yet: a host reads one as it prepares a machine, and one made from a base only where its host prepares it; see clankerbox get dev",
              machine: "dev",
              state: "stopped, wants running (starting)",
            }),
          ],
        ];

        for (const [held, expected] of said) {
          expect(plain(yield* Effect.flip(sshTarget(held)))).toStrictEqual(
            plain(expected)
          );
        }
      })
  );

  it.effect(
    "pinnedSsh logs in as the user at the address, so no ssh_config block for the ID applies, pins the key under the ID in a one-line known-hosts file, and puts the caller's args after the address",
    () =>
      Effect.gen(function* () {
        const target = yield* sshTarget(reachable);

        const args = yield* pinnedSsh(target, "dev", [
          "-L",
          "8080:localhost:80",
          "uptime",
        ]);

        const knownHosts = knownHostsIn(args);

        expect(args).toStrictEqual([
          "-l",
          "dev",
          "-o",
          "Port=10022",
          "-o",
          "ConnectTimeout=15",
          "-o",
          "HostKeyAlias=dev",
          "-o",
          `UserKnownHostsFile=${knownHosts}`,
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          "-o",
          "StrictHostKeyChecking=yes",
          "100.64.0.7",
          "-L",
          "8080:localhost:80",
          "uptime",
        ]);
        expect(yield* read(knownHosts)).toBe(
          "dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n"
        );
      }).pipe(Effect.scoped)
  );

  it.effect("pinnedSsh's known-hosts file goes when its scope ends", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const knownHosts = yield* Effect.scoped(
        Effect.map(
          Effect.flatMap(sshTarget(reachable), (target) =>
            pinnedSsh(target, "user", [])
          ),
          knownHostsIn
        )
      );

      expect(yield* fs.exists(knownHosts)).toBe(false);
    })
  );

  it.effect(
    "pinnedSsh writes its known-hosts file in the directory it is given, and leaves that directory to its caller",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();

        const knownHosts = yield* Effect.scoped(
          Effect.map(
            Effect.flatMap(sshTarget(reachable), (target) =>
              pinnedSsh(target, "user", [], directory)
            ),
            knownHostsIn
          )
        );

        expect(knownHosts).toBe(`${directory}/known_hosts`);
        expect(yield* read(knownHosts)).toBe(
          "dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n"
        );
      }).pipe(Effect.scoped)
  );
});

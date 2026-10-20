import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";
import { type Machine, pinnedSsh, ScriptFailed, sshTarget, WrongState } from "../src/index.ts";
import { read } from "./files.ts";
import { machine } from "./stub-host.ts";

const login = { user: "user", host: "100.64.0.7", port: 10_022 };

const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux_dev";

const reachable = machine("linux_dev", { ssh: login, hostKey });

const knownHostsOption = "UserKnownHostsFile=";

const knownHostsIn = (args: ReadonlyArray<string>): string =>
  args.find((arg) => arg.startsWith(knownHostsOption))?.slice(knownHostsOption.length) ?? "";

layer(NodeServices.layer)((it) => {
  it.effect("a running, prepared machine is a target with its login and host key", () =>
    Effect.gen(function* () {
      expect(yield* sshTarget(reachable)).toEqual({ id: "linux_dev", login, hostKey });
    }),
  );

  it.effect(
    "a machine without an endpoint or a host key is no target, and says which it lacks",
    () =>
      Effect.gen(function* () {
        const said: ReadonlyArray<readonly [Machine, WrongState]> = [
          [
            machine("linux_dev", { state: "stopped", hostKey }),
            new WrongState({
              message: "linux_dev has no SSH endpoint (stopped): see clankerbox get linux_dev",
              machine: "linux_dev",
              state: "stopped",
            }),
          ],
          [
            machine("linux_dev", {
              phase: "failed",
              ssh: login,
              error: new ScriptFailed({ message: "setup exited 1", script: "setup" }),
            }),
            new WrongState({
              message:
                "linux_dev has no SSH host key on record (running (failed)): see clankerbox get linux_dev",
              machine: "linux_dev",
              state: "running (failed)",
            }),
          ],
          [
            machine("linux_dev", { state: "stopped", desired: "running", phase: "starting" }),
            new WrongState({
              message:
                "linux_dev has no SSH endpoint (stopped, wants running (starting)): see clankerbox get linux_dev",
              machine: "linux_dev",
              state: "stopped, wants running (starting)",
            }),
          ],
        ];

        for (const [held, expected] of said) {
          expect(yield* Effect.flip(sshTarget(held))).toEqual(expected);
        }
      }),
  );

  it.effect(
    "pinnedSsh logs in as the user at the address, so no ssh_config block for the ID applies, pins the key under the ID in a one-line known-hosts file, and puts the caller's args after the address",
    () =>
      Effect.gen(function* () {
        const target = yield* sshTarget(reachable);
        const args = yield* pinnedSsh(target, "dev", ["-L", "8080:localhost:80", "uptime"]);
        const knownHosts = knownHostsIn(args);

        expect(args).toEqual([
          "-l",
          "dev",
          "-o",
          "Port=10022",
          "-o",
          "HostKeyAlias=linux_dev",
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
          "linux_dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("pinnedSsh's known-hosts file goes when its scope ends", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const knownHosts = yield* Effect.scoped(
        Effect.map(
          Effect.flatMap(sshTarget(reachable), (target) => pinnedSsh(target, "user", [])),
          knownHostsIn,
        ),
      );

      expect(yield* fs.exists(knownHosts)).toBe(false);
    }),
  );
});

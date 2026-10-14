import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";
import { type Machine, pinnedSsh, sshTarget } from "../src/index.ts";
import { read } from "./files.ts";
import { machine } from "./stub-host.ts";

const login = { user: "root", host: "100.64.0.7", port: 10_022 };

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
        const said: ReadonlyArray<readonly [Machine, string]> = [
          [
            machine("linux_dev", { state: "stopped", hostKey }),
            "linux_dev has no SSH endpoint (stopped, createMachine done): see clankerbox get linux_dev",
          ],
          [
            machine("linux_dev", {
              made: false,
              ssh: login,
              action: {
                name: "createMachine",
                status: "failed",
                error: { tag: "Precondition", message: "setup exited 1" },
              },
            }),
            "linux_dev has no SSH host key on record (running (unmade), createMachine failed): see clankerbox get linux_dev",
          ],
        ];

        for (const [held, message] of said) {
          const error = yield* Effect.flip(sshTarget(held));

          expect(error._tag).toBe("Precondition");
          expect(error.message).toBe(message);
        }
      }),
  );

  it.effect(
    "pinnedSsh logs in as the user, pins the key under the ID in a one-line known-hosts file, and puts the caller's args after the destination",
    () =>
      Effect.gen(function* () {
        const target = yield* sshTarget(reachable);
        const args = yield* pinnedSsh(target, "dev", ["-L", "8080:localhost:80", "uptime"]);
        const knownHosts = knownHostsIn(args);

        expect(args).toEqual([
          "-l",
          "dev",
          "-o",
          "HostName=100.64.0.7",
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
          "linux_dev",
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
          Effect.flatMap(sshTarget(reachable), (target) => pinnedSsh(target, "root", [])),
          knownHostsIn,
        ),
      );

      expect(yield* fs.exists(knownHosts)).toBe(false);
    }),
  );
});

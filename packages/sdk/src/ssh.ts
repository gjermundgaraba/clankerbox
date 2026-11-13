import { Effect, FileSystem, Path } from "effect";
import type { PlatformError, Scope } from "effect";

import { WrongState } from "./errors.ts";
import { isResting, stateLabel } from "./resources.ts";
import type { Machine, SshLogin } from "./resources.ts";

export interface SshTarget {
  readonly id: string;
  readonly login: SshLogin;
  readonly hostKey: string;
}

const noLoginBecause = ({
  id,
  hostKey,
  template,
  state,
  desired,
  phase,
}: Machine) => {
  if (hostKey === undefined && !isResting(phase)) {
    return `its host has no SSH host key on record for it yet: a host reads one as it prepares a machine, and one made from a base only where its host prepares it; see clankerbox get ${id}`;
  }

  const unprepared =
    "its host has no SSH host key on record for it, as for a machine made from a base the host didn't prepare";

  if ((state === "stopped" || state === "paused") && desired === state) {
    const start = `its VM doesn't run, so start it with clankerbox start ${id}`;

    return hostKey === undefined && template === undefined
      ? `${start}; ${unprepared}, so then reach it with clankerbox exec, or create it from a template`
      : start;
  }

  if (hostKey === undefined) {
    return template === undefined
      ? `${unprepared}; reach it with clankerbox exec, or create it from a template`
      : `its host has no SSH host key on record for it; see clankerbox get ${id}`;
  }

  return `see clankerbox get ${id}`;
};

/**
 * A machine with no `ssh` login is `WrongState`, saying why: no host key on record yet, on a
 * machine not yet prepared, or at all, as for one made from a base its host didn't prepare, or a
 * VM that doesn't run, which a start runs.
 */
export const sshTarget = (
  machine: Machine
): Effect.Effect<SshTarget, WrongState> => {
  const { id, ssh: login, hostKey } = machine;

  if (login !== undefined && hostKey !== undefined) {
    return Effect.succeed({ id, login, hostKey });
  }

  const state = stateLabel(machine);

  return Effect.fail(
    new WrongState({
      message: `${id} has no SSH login (${state}): ${noLoginBecause(machine)}`,
      machine: id,
      state,
    })
  );
};

/** A known_hosts line pinning `name` to a host key on record, `<type> <base64>`. */
export const knownHostsLine = (name: string, hostKey: string): string => {
  const [type = "", key = ""] = hostKey.trim().split(/\s+/u);

  return `${name} ${type} ${key}\n`;
};

const sshArguments = (
  target: SshTarget,
  user: string,
  knownHosts: string,
  extra: readonly string[]
): string[] => [
  "-l",
  user,
  "-o",
  `Port=${target.login.port}`,
  "-o",
  `HostKeyAlias=${target.id}`,
  "-o",
  `UserKnownHostsFile=${knownHosts}`,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "StrictHostKeyChecking=yes",
  target.login.host,
  ...extra,
];

/**
 * ssh's arguments to the target's address, pinned to its host key through a known-hosts file that
 * lasts as long as the scope, which must outlast the ssh. The destination is the address, not the
 * ID, so no ssh_config block for the ID applies. Ports change on fork and restore, so read the
 * target anew for each ssh.
 */
export const pinnedSsh = (
  target: SshTarget,
  user: string,
  extra: readonly string[]
): Effect.Effect<
  string[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "clankerbox-ssh-",
    });

    const knownHosts = path.join(directory, "known_hosts");

    yield* fs.writeFileString(
      knownHosts,
      knownHostsLine(target.id, target.hostKey)
    );

    return sshArguments(target, user, knownHosts, extra);
  });

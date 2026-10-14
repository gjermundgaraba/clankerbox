import { Effect, FileSystem, Path, type PlatformError, type Scope } from "effect";
import { WrongState } from "./errors.ts";
import { type Machine, type SshLogin, stateLabel } from "./resources.ts";

export interface SshTarget {
  readonly id: string;
  readonly login: SshLogin;
  readonly hostKey: string;
}

/**
 * Only a running machine has an endpoint, and only a prepared one a host key; a machine without
 * either is `WrongState`, naming what it lacks and why.
 */
export const sshTarget = (machine: Machine): Effect.Effect<SshTarget, WrongState> => {
  const { id, ssh: login, hostKey, action } = machine;

  if (login !== undefined && hostKey !== undefined) {
    return Effect.succeed({ id, login, hostKey });
  }

  const lacks = login === undefined ? "SSH endpoint" : "SSH host key on record";
  const state = stateLabel(machine);
  const message = `${id} has no ${lacks} (${state}, ${action.name} ${action.status}): see clankerbox get ${id}`;

  return Effect.fail(
    login === undefined
      ? new WrongState({ message, machine: id, state, needs: "running" })
      : new WrongState({ message, machine: id, state }),
  );
};

/**
 * ssh looks the key up by `HostKeyAlias`, so the line doesn't depend on the endpoint, which
 * changes.
 */
const knownHostsLine = (id: string, hostKey: string): string => {
  const [type = "", key = ""] = hostKey.trim().split(/\s+/u);

  return `${id} ${type} ${key}\n`;
};

/**
 * OpenSSH keeps the first user it is given, so the leading `-l` decides it. The destination is
 * the machine's ID, so a `Host <pattern>` block in the user's ssh config can match it, while the
 * endpoint and the pinned key come from options no config overrides. The caller's arguments go
 * after the destination, where OpenSSH still reads options (`-L …`) before a remote command.
 */
const sshArguments = (
  target: SshTarget,
  user: string,
  knownHosts: string,
  extra: ReadonlyArray<string>,
): Array<string> => [
  "-l",
  user,
  "-o",
  `HostName=${target.login.host}`,
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
  target.id,
  ...extra,
];

/**
 * ssh's arguments, pinned to the target's host key through a known-hosts file that lasts as long
 * as the scope, which must outlast the ssh. Ports change on fork, restore, and every boat start,
 * so read the target anew for each ssh.
 */
export const pinnedSsh = (
  target: SshTarget,
  user: string,
  extra: ReadonlyArray<string>,
): Effect.Effect<
  Array<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clankerbox-ssh-" });

    const knownHosts = path.join(directory, "known_hosts");

    yield* fs.writeFileString(knownHosts, knownHostsLine(target.id, target.hostKey));

    return sshArguments(target, user, knownHosts, extra);
  });

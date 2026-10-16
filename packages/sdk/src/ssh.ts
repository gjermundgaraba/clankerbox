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
  const { id, ssh: login, hostKey } = machine;

  if (login !== undefined && hostKey !== undefined) {
    return Effect.succeed({ id, login, hostKey });
  }

  const lacks = login === undefined ? "SSH endpoint" : "SSH host key on record";
  const state = stateLabel(machine);
  const message = `${id} has no ${lacks} (${state}): see clankerbox get ${id}`;

  return Effect.fail(new WrongState({ message, machine: id, state }));
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
  extra: ReadonlyArray<string>,
): Array<string> => [
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
 * ID, so no ssh_config block for the ID applies. Ports change on fork, restore, and every boat
 * start, so read the target anew for each ssh.
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

/**
 * The system `ssh`'s arguments for a machine, pinned to its host key: what `clankerbox ssh` runs,
 * and what anything else that reaches a guest through port 22 does, such as a port forward.
 */
import { Effect, FileSystem, Path, type PlatformError, type Scope } from "effect";
import type { Machine, SshLogin } from "./resources.ts";

/** What ssh needs of a machine: where it is reached, as whom, and the host key to pin. */
export interface SshTarget {
  readonly id: string;
  readonly login: SshLogin;
  readonly hostKey: string;
}

/**
 * The machine's SSH target, or what it lacks: an endpoint, which only a running machine has, or
 * a host key, which preparation records.
 */
export const sshTarget = (
  machine: Machine,
): SshTarget | { readonly lacks: "SSH endpoint" | "SSH host key on record" } => {
  const { id, ssh: login, hostKey } = machine;

  if (login === undefined) {
    return { lacks: "SSH endpoint" };
  }

  return hostKey === undefined ? { lacks: "SSH host key on record" } : { id, login, hostKey };
};

/**
 * The known-hosts line pinning the machine's host key under its ID: ssh looks the key up by
 * `HostKeyAlias`, so the line doesn't depend on the endpoint, which changes.
 */
const knownHostsLine = (id: string, hostKey: string): string => {
  const [type = "", key = ""] = hostKey.trim().split(/\s+/u);

  return `${id} ${type} ${key}\n`;
};

/**
 * ssh's arguments. OpenSSH keeps the first user it is given, so the leading `-l` decides it:
 * one in the caller's arguments or in an ssh config doesn't apply. The destination is the
 * machine's ID, so a `Host <pattern>` block in the user's ssh config can set keys and options
 * per machine; the endpoint and the pinned host key come from command-line options, which no
 * config overrides. The caller's arguments go after the destination, where OpenSSH still reads
 * options (`-L …`) before a remote command.
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
 * Writes a one-line known-hosts file pinning the target's host key, and returns the arguments
 * that run ssh against it with strict host key checking, as `user`. The file lasts as long as
 * the scope, which must outlast the ssh it is for. Ports change on fork and restore, and on
 * boat at every start, so a target is read anew for each ssh.
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

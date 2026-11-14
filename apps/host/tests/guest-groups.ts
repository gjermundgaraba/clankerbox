import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";

const leader = [
  'if [ "$1" != - ]; then exec <"$1/in" >"$1/out" 2>"$1/err" 3>"$1/code"; fi',
  "shift",
  '"$@" 3>&- 4<&-',
  "printf '%s\\n' \"$?\" >&3",
  "exec 0<&- 1>&- 2>&- 3>&-",
  "read -r _ <&4",
  "kill -s KILL 0",
].join("\n");

/** A guest command's stdio, and the exit status its leader writes once it ends. */
export interface Piped {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly status: Readable;
}

interface Started {
  readonly leader: ChildProcess;
  readonly root: string;
}

/**
 * The guest commands a fake runs, as a provider's guest does: each in a process group of its own
 * that a cut caller leaves running, ended only when its machine stops or goes, or the fake ends.
 * The group's leader runs the command, writes its status and closes its own ends of the command's
 * stdio, and then holds the group, so its ID is this fake's for as long as the fake may signal
 * it. Once the pipe the fake holds on its fd 4 ends, the fake is gone, and the leader ends its
 * group itself.
 */
export const guestGroups = () => {
  const groups = new Set<Started>();

  const ended = async (started: Started) => {
    const { leader: child } = started;

    groups.delete(started);

    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      const exited = once(child, "exit");

      process.kill(-child.pid, "SIGKILL");
      await exited;
    }

    child.stdio[4]?.destroy();
  };

  const started = (
    root: string,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    fifos: string | undefined
  ) => {
    const child = spawn(
      "/bin/sh",
      ["-c", leader, "leader", fifos ?? "-", ...argv],
      {
        env,
        detached: true,
        stdio:
          fifos === undefined
            ? ["pipe", "pipe", "pipe", "pipe", "pipe"]
            : ["ignore", "ignore", "ignore", "ignore", "pipe"],
      }
    );

    const group = { leader: child, root };

    groups.add(group);
    child.once("exit", () => {
      groups.delete(group);
    });

    return child;
  };

  return {
    piped: (
      root: string,
      argv: readonly string[],
      env: NodeJS.ProcessEnv
    ): Piped => {
      const [stdin, stdout, stderr, status] = started(
        root,
        argv,
        env,
        undefined
      ).stdio;

      if (
        !(stdin instanceof Writable) ||
        !(stdout instanceof Readable) ||
        !(stderr instanceof Readable) ||
        !(status instanceof Readable)
      ) {
        throw new TypeError("a piped guest command has no pipes");
      }

      return { stdin, stdout, stderr, status };
    },
    overFifos: (
      root: string,
      argv: readonly string[],
      env: NodeJS.ProcessEnv,
      fifos: string
    ) => {
      started(root, argv, env, fifos);
    },
    end: async (root: string) => {
      await Promise.all(
        groups
          .values()
          .filter((each) => each.root === root)
          .map(ended)
      );
    },
    endAll: async () => {
      await Promise.all([...groups].map(ended));
    },
  };
};

export type GuestGroups = ReturnType<typeof guestGroups>;

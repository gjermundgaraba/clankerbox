import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Command } from "effect/cli";
import { checkpoint } from "./checkpoints.ts";
import { host } from "./host.ts";
import { capacity, hosts } from "./hosts.ts";
import {
  create,
  deleteMachine,
  fork,
  getMachine,
  machines,
  restore,
  start,
  stop,
} from "./machines/commands.ts";
import { prebuild } from "./prebuilds.ts";
import { profiles } from "./profiles.ts";
import { ssh } from "./ssh.ts";

/**
 * The CLI and the host role. Either exits 130 when SIGINT or SIGTERM interrupts it, the default
 * teardown's code, so a unit that stops the host lists 130 as a success.
 */
const clankerbox = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
  Command.withSubcommands([
    hosts,
    capacity,
    machines,
    getMachine,
    profiles,
    create,
    prebuild,
    start,
    stop,
    deleteMachine,
    fork,
    checkpoint,
    restore,
    ssh,
    host,
  ]),
);

/** Runs the command `args` names. */
export const dispatch = Command.runWith(clankerbox, { version });

/** Runs the command the process's arguments name. */
export const main = Command.run(clankerbox, { version });

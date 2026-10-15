import { type actionsByName, version } from "@gjermundgaraba/clankerbox-sdk";
import { Command } from "effect/cli";
import {
  capture,
  checkpoint,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
} from "./checkpoints.ts";
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
import { ssh, sshKnownHosts, sshProxy } from "./ssh.ts";

export const actionCommands = {
  listMachines: machines,
  getMachine,
  createMachine: create,
  startMachine: start,
  stopMachine: stop,
  deleteMachine,
  forkMachine: fork,
  restoreMachine: restore,
  listCheckpoints,
  getCheckpoint,
  captureCheckpoint: capture,
  deleteCheckpoint,
  getHost: hosts,
  getCapacity: capacity,
} satisfies Record<keyof typeof actionsByName, Command.Command.Any>;

export const clankerbox = Command.make("clankerbox").pipe(
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
    sshProxy,
    sshKnownHosts,
    host,
  ]),
);

export const dispatch = Command.runWith(clankerbox, { version });

export const main = Command.run(clankerbox, { version });

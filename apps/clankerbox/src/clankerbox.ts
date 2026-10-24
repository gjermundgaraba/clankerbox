import { type actionsByName, version } from "@gjermundgaraba/clankerbox-sdk";
import { Command } from "effect/cli";
import { ampOrb } from "./amp-orb.ts";
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
  exec,
  fork,
  getMachine,
  machines,
  pause,
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
  pauseMachine: pause,
  deleteMachine,
  forkMachine: fork,
  restoreMachine: restore,
  execMachine: exec,
  listCheckpoints,
  getCheckpoint,
  captureCheckpoint: capture,
  deleteCheckpoint,
  prebuildCheckpoint: prebuild,
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
    pause,
    deleteMachine,
    fork,
    checkpoint,
    restore,
    exec,
    ssh,
    sshProxy,
    sshKnownHosts,
    ampOrb,
    host,
  ]),
);

export const dispatch = Command.runWith(clankerbox, { version });

export const main = Command.run(clankerbox, { version });

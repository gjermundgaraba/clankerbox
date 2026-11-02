import { version } from "@gjermundgaraba/clankerbox-sdk";
import type { actionsByName } from "@gjermundgaraba/clankerbox-sdk";
import { Command } from "effect/cli";

import {
  capture,
  checkpoint,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
} from "./checkpoints.ts";
import { capacity, hosts } from "./hosts.ts";
import {
  create,
  deleteMachine,
  exec,
  fork,
  getMachine,
  machines,
  pause,
  resize,
  restore,
  start,
  stop,
} from "./machines/commands.ts";
import { getPrebuild, prebuild } from "./prebuilds.ts";
import { profiles } from "./profiles.ts";
import { ssh, sshKnownHosts, sshProxy } from "./ssh.ts";

export const actionCommands = {
  listMachines: machines,
  getMachine,
  createMachine: create,
  startMachine: start,
  stopMachine: stop,
  pauseMachine: pause,
  resizeMachine: resize,
  deleteMachine,
  forkMachine: fork,
  restoreMachine: restore,
  listCheckpoints,
  getCheckpoint,
  captureCheckpoint: capture,
  deleteCheckpoint,
  prebuildCheckpoint: prebuild,
  getPrebuild,
  listHosts: hosts,
  getCapacity: capacity,
  execMachine: exec,
} satisfies Record<keyof typeof actionsByName, Command.Command.Any>;

export const clankerbox = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines for coding agents."),
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
    resize,
    deleteMachine,
    fork,
    checkpoint,
    restore,
    exec,
    ssh,
    sshProxy,
    sshKnownHosts,
  ])
);

export const dispatch = Command.runWith(clankerbox, { version });

export const main = Command.run(clankerbox, { version });

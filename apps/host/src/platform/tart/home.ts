import { homedir } from "node:os";
import path from "node:path";

import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import type { FileSystem } from "effect";

import { files } from "../process.ts";

/**
 * A Tart home, read as Tart lays it out. Reading a VM's directory costs the same however many VMs
 * the home holds, where `tart list` and `tart get` open each VM's disk through `diskutil`.
 */
export interface Home {
  readonly vms: string;
  readonly fetching: string;
  readonly directory: (vm: string) => string;
  /** The file whose lock `tart run` holds while the VM runs. */
  readonly config: (vm: string) => string;
  /** What the VM's directory holds, if Tart counts it as a VM: whether a suspend saved it. */
  readonly look: (
    vm: string
  ) => Effect.Effect<{ readonly saved: boolean } | undefined, Internal>;
}

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L93
// https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L141
const initialized = (entries: ReadonlySet<string>): boolean => {
  if (!entries.has("config.json") || !entries.has("nvram.bin")) {
    return false;
  }

  const overlaid = entries.has("overlay.asif");

  return entries.has("disk.img")
    ? !overlaid
    : overlaid && entries.has("manifest.json");
};

export const make = (
  fs: FileSystem.FileSystem,
  setting: string | undefined
): Home => {
  const home = setting ?? path.join(homedir(), ".tart");
  const vms = path.join(home, "vms");
  const directory = (vm: string) => path.join(vms, vm);

  return {
    vms,
    fetching: path.join(home, "cbx-fetching"),
    directory,
    // https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L48
    config: (vm) => path.join(directory(vm), "config.json"),
    look: (vm) =>
      files(
        `couldn't read ${directory(vm)}`,
        fs.readDirectory(directory(vm)).pipe(
          Effect.map((names) => new Set(names)),
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(new Set<string>())
          )
        )
      ).pipe(
        // https://github.com/openai/tart/blob/2.41.1/Sources/tart/VMDirectory.swift#L65
        Effect.map((entries) =>
          initialized(entries)
            ? { saved: entries.has("state.vzvmsave") }
            : undefined
        )
      ),
  };
};

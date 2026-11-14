import { Effect, FileSystem, Layer, Option } from "effect";

import { Box } from "../box.ts";
import type { Facts } from "../box.ts";
import type { PortRange, ReservedPorts } from "../machine-ports.ts";
import { processEnded } from "./process.ts";

// https://docs.kernel.org/networking/ip-sysctl.html#ip-variables
const portRangeFile = "/proc/sys/net/ipv4/ip_local_port_range";

/**
 * The ports an OS hands its own outgoing connections where its box tells no other, by Node's
 * `process.platform`: Linux's default `ip_local_port_range`, and elsewhere IANA's dynamic ports,
 * which macOS takes (https://www.rfc-editor.org/rfc/rfc6335.html#section-6).
 */
export const defaultEphemeralPorts = (platform: string): ReservedPorts =>
  platform === "linux"
    ? { first: 32_768, last: 60_999, owner: "Linux's default ephemeral ports" }
    : {
        first: 49_152,
        last: 65_535,
        owner:
          platform === "darwin"
            ? "macOS's ephemeral ports"
            : "IANA's dynamic ports, which this OS takes for its ephemeral ones",
      };

const rangeIn = (text: string): PortRange | undefined => {
  const [first = 0, last = 0, ...rest] = text.trim().split(/\s+/u).map(Number);

  return rest.length === 0 &&
    Number.isInteger(first) &&
    Number.isInteger(last) &&
    first >= 1 &&
    first <= last &&
    last <= 65_535
    ? { first, last }
    : undefined;
};

const linuxEphemeral = (
  rangeFile: string
): Effect.Effect<ReservedPorts, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* Effect.option(fs.readFileString(rangeFile));
    const range = Option.flatMapNullishOr(text, rangeIn);

    if (Option.isSome(range)) {
      return {
        ...range.value,
        owner: "this box's ephemeral ports, its ip_local_port_range",
      };
    }

    const fallback = defaultEphemeralPorts("linux");

    yield* Effect.logWarning(
      `couldn't read this box's ephemeral ports from ${rangeFile}, so machine ports stay out of Linux's default ${fallback.first}-${fallback.last}`
    );

    return fallback;
  });

/** The box's facts on the OS Node's `process.platform` names, reading Linux's port range from `rangeFile`. */
export const make = (
  platform: string,
  rangeFile = portRangeFile
): Effect.Effect<Facts, never, FileSystem.FileSystem> =>
  Effect.map(
    platform === "linux"
      ? linuxEphemeral(rangeFile)
      : Effect.succeed(defaultEphemeralPorts(platform)),
    (ephemeralPorts) => ({
      uid: process.getuid?.(),
      ended: processEnded,
      ephemeralPorts,
    })
  );

export const layer: Layer.Layer<Box, never, FileSystem.FileSystem> =
  Layer.effect(Box, make(process.platform));

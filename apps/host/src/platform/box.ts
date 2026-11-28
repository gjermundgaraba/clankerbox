import path from "node:path";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Layer, Option } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { Box } from "../box.ts";
import type { Facts } from "../box.ts";
import type { PortRange, ReservedPorts } from "../settings.ts";
import { cliIn, processEnded } from "./process.ts";

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

/**
 * The first file in a recursive GNU `ls -lRA` listing whose mode a `+` follows, as GNU ls marks a
 * file with a POSIX ACL:
 * https://www.gnu.org/software/coreutils/manual/html_node/What-information-is-listed.html
 */
export const aclHolderIn = (
  directory: string,
  listing: string
): string | undefined => {
  let listed = directory;

  for (const line of listing.split("\n")) {
    if (line.endsWith(":") && !line.startsWith(" ")) {
      listed = line.slice(0, -1);
    } else if (/^[-dlcbps][-rwxsStT]{9}\+ /u.test(line)) {
      const name = line.split(/ +/u).slice(8).join(" ").split(" -> ")[0] ?? "";

      return path.join(listed, name);
    }
  }

  return undefined;
};

const searchPath =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const make = (
  platform: string,
  rangeFile = portRangeFile
): Effect.Effect<
  Facts,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const ephemeralPorts =
      platform === "linux"
        ? yield* linuxEphemeral(rangeFile)
        : defaultEphemeralPorts(platform);

    const { run } = yield* cliIn(
      { PATH: searchPath, LC_ALL: "C" },
      { detached: false }
    );

    const aclHolder = (directory: string) =>
      Effect.flatMap(
        run(
          "ls",
          ["-lRA", "--quoting-style=literal", directory],
          `ls -lRA ${directory}`
        ),
        ({ exitCode, stdout, stderr }) =>
          exitCode === 0
            ? Effect.succeed(aclHolderIn(directory, stdout))
            : Effect.fail(
                new Internal({
                  message: `couldn't list ${directory} for POSIX ACLs: ls exited ${exitCode}: ${stderr.trim()}`,
                })
              )
      );

    return {
      uid: process.getuid?.(),
      ended: processEnded,
      ephemeralPorts,
      aclHolder,
    };
  });

export const layer: Layer.Layer<
  Box,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Box, make(process.platform));

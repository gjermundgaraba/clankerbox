/**
 * The host config: one JSON file, read from `clankerbox host --config PATH`. A host process
 * runs exactly one runtime, so the config names it, with that runtime's own settings.
 */
import { BlockList, isIP } from "node:net";
import { totalmem } from "node:os";
import { HostId, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path, Schema } from "effect";

/**
 * Where a host may listen and publish: its tailnet address, or loopback for a local host. The
 * tailnet is the only gate in front of the API, which has no auth of its own, so a wildcard or
 * public address is refused. Tailscale assigns 100.64.0.0/10 and fd7a:115c:a1e0::/48
 * (tailscale.com/kb/1015, kb/1033).
 */
const reachable = new BlockList();

const subnets = [
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["fd7a:115c:a1e0::", 48, "ipv6"],
  ["::1", 128, "ipv6"],
] as const;

for (const [network, prefix, family] of subnets) {
  reachable.addSubnet(network, prefix, family);
}

const addressRule = "a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a loopback address";

export const Address = Schema.String.check(
  Schema.makeFilter((address: string) => {
    const family = isIP(address);

    return (
      (family !== 0 && reachable.check(address, family === 4 ? "ipv4" : "ipv6")) || addressRule
    );
  }),
);

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

const Size = Schema.Int.check(Schema.isGreaterThan(0));

/** The smolvm runtime's settings. */
export const SmolvmSettings = Schema.Struct({
  /** The versioned install prefix, such as `/opt/smolvm/1.22.2`. */
  prefix: Schema.String,
  /** Where machines' guest port 22 is published (`SMOLVM_PUBLISH_ADDR`). */
  publishAddress: Address,
  /** The RAM the host's machines may use together. Default: physical RAM minus 2 GiB. */
  ramBudgetMib: Schema.optionalKey(Size),
});

export const HostConfigFile = Schema.Struct({
  id: HostId,
  runtime: Schema.Literal("smolvm"),
  listen: Schema.Struct({ address: Address, port: Port }),
  /** Relative to the config file. */
  stateDir: Schema.String,
  /** Base name to image. Hosts that offer the same image use the same name. */
  bases: Schema.Record(Schema.String, Schema.String),
  smolvm: SmolvmSettings,
});

export type HostConfigFile = typeof HostConfigFile.Type;

/** The smolvm settings with their defaults applied. */
export interface Smolvm {
  readonly prefix: string;
  readonly publishAddress: string;
  readonly ramBudgetMib: number;
}

/** The host config as the host uses it: paths resolved and defaults applied. */
export interface HostConfig {
  readonly id: string;
  readonly runtime: "smolvm";
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
  readonly smolvm: Smolvm;
}

const mib = 1024 * 1024;

/** Room for the OS and the host processes. */
const reservedMib = 2048;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostConfigFile));

/** Applies defaults and resolves `stateDir` against the config file's directory. */
export const resolveConfig = (
  decoded: HostConfigFile,
  directory: string,
): Effect.Effect<HostConfig, Invalid, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const ramBudgetMib = decoded.smolvm.ramBudgetMib ?? Math.floor(totalmem() / mib) - reservedMib;

    if (ramBudgetMib <= 0) {
      return yield* new Invalid({
        message: `smolvm.ramBudgetMib: physical RAM leaves no default budget; set one`,
      });
    }

    return {
      id: decoded.id,
      runtime: decoded.runtime,
      listen: decoded.listen,
      stateDir: path.resolve(directory, decoded.stateDir),
      bases: new Map(Object.entries(decoded.bases)),
      smolvm: { ...decoded.smolvm, ramBudgetMib },
    };
  });

/** Reads and decodes the config file at `file`. Unknown keys are refused, as in every input. */
export const loadConfig = (
  file: string,
): Effect.Effect<HostConfig, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(file);

    const text = yield* fs
      .readFileString(resolved)
      .pipe(
        Effect.mapError(
          (error) =>
            new Invalid({ message: `couldn't read host config ${resolved}: ${error.message}` }),
        ),
      );

    const decoded = yield* decodeConfig(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `host config ${resolved}: ${error.message}` }),
      ),
    );

    return yield* resolveConfig(decoded, path.dirname(resolved));
  });

/**
 * The host config: one JSON file, read from `clankerbox host --config PATH`. A host process
 * runs exactly one runtime, so the config names it, with that runtime's own settings.
 */
import { BlockList, isIP } from "node:net";
import { totalmem } from "node:os";
import { HostId, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path, Schema } from "effect";
import { firstPort, lastPort } from "./ports.ts";

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

const Address = Schema.String.check(
  Schema.makeFilter((address: string) => {
    const family = isIP(address);

    return (
      (family !== 0 && reachable.check(address, family === 4 ? "ipv4" : "ipv6")) || addressRule
    );
  }),
);

/**
 * The API's port, outside the machines' range, on every runtime. The tailnet is the API's only
 * gate, so a policy that opens that range to the clients that run `clankerbox ssh` would open an
 * API port inside it to them too. That holds for a boat host, which publishes no machine ports:
 * in production it shares the Linux host's tailnet address with the smolvm host, whose range such
 * a policy opens. The API never takes a port a machine would be given, either.
 */
const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
  Schema.makeFilter(
    (port: number) =>
      port < firstPort ||
      port > lastPort ||
      `a port outside ${firstPort}-${lastPort}, the machines' range`,
  ),
);

const Size = Schema.Int.check(Schema.isGreaterThan(0));

/** The smolvm runtime's settings. */
const SmolvmSettings = Schema.Struct({
  /** The versioned install prefix, such as `/opt/smolvm/1.22.2`. */
  prefix: Schema.String,
  /** Where machines' guest port 22 is published (`SMOLVM_PUBLISH_ADDR`). Default: `listen.address`. */
  publishAddress: Schema.optionalKey(Address),
  /** The RAM the host's machines may use together. Default: physical RAM minus 2 GiB. */
  ramBudgetMib: Schema.optionalKey(Size),
});

/** The Tart runtime's settings. */
const TartSettings = Schema.Struct({
  /**
   * The `tart` executable of a versioned install, such as
   * `/opt/tart/2.40.1/tart.app/Contents/MacOS/tart`. VM jobs run it from there, so an upgrade goes
   * into a new directory.
   */
  binary: Schema.String,
  /** Where the forwarder listens for machines' guest port 22. Default: `listen.address`. */
  publishAddress: Schema.optionalKey(Address),
});

/**
 * The boat runtime's settings. The API key is a secret: it stays `Redacted` from the moment it is
 * decoded, so nothing that prints the config prints it.
 */
const BoatSettings = Schema.Struct({
  /** A boat API key, `boat_…`, sent only as the bearer token of boat's API. */
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isNonEmpty())),
});

/** What every host config holds, whatever its runtime. */
const common = {
  id: HostId,
  listen: Schema.Struct({ address: Address, port: Port }),
  /** Relative to the config file. */
  stateDir: Schema.String,
  /** Base name to image. Hosts that offer the same image use the same name. */
  bases: Schema.Record(Schema.String, Schema.String),
};

const HostConfigFile = Schema.Union([
  Schema.Struct({ ...common, runtime: Schema.Literal("smolvm"), smolvm: SmolvmSettings }),
  Schema.Struct({ ...common, runtime: Schema.Literal("tart"), tart: TartSettings }),
  Schema.Struct({ ...common, runtime: Schema.Literal("boat"), boat: BoatSettings }),
]);

type HostConfigFile = typeof HostConfigFile.Type;

/** The smolvm settings with their defaults applied. */
export type Smolvm = Required<typeof SmolvmSettings.Type>;

/** The Tart settings with their defaults applied. */
export type Tart = Required<typeof TartSettings.Type>;

/** The boat settings. */
export type Boat = typeof BoatSettings.Type;

/** What every host config holds, as the host uses it: paths resolved. */
interface Common {
  readonly id: string;
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
}

/** A smolvm host's config. */
export interface SmolvmHost extends Common {
  readonly runtime: "smolvm";
  readonly smolvm: Smolvm;
}

/** A Tart host's config. */
export interface TartHost extends Common {
  readonly runtime: "tart";
  readonly tart: Tart;
}

/** A boat host's config. */
export interface BoatHost extends Common {
  readonly runtime: "boat";
  readonly boat: Boat;
}

/** The host config as the host uses it: paths resolved and defaults applied. */
export type HostConfig = SmolvmHost | TartHost | BoatHost;

const mib = 1024 * 1024;

/** Room for the OS and the host processes. */
const reservedMib = 2048;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostConfigFile));

/** Applies defaults and resolves `stateDir` against the config file's directory. */
const resolveConfig = (
  decoded: HostConfigFile,
  directory: string,
): Effect.Effect<HostConfig, Invalid, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    const common: Common = {
      id: decoded.id,
      listen: decoded.listen,
      stateDir: path.resolve(directory, decoded.stateDir),
      bases: new Map(Object.entries(decoded.bases)),
    };

    if (decoded.runtime === "boat") {
      return { ...common, runtime: decoded.runtime, boat: decoded.boat };
    }

    if (decoded.runtime === "tart") {
      return {
        ...common,
        runtime: decoded.runtime,
        tart: {
          ...decoded.tart,
          publishAddress: decoded.tart.publishAddress ?? decoded.listen.address,
        },
      };
    }

    const ramBudgetMib = decoded.smolvm.ramBudgetMib ?? Math.floor(totalmem() / mib) - reservedMib;

    if (ramBudgetMib <= 0) {
      return yield* new Invalid({
        message: `smolvm.ramBudgetMib: physical RAM leaves no default budget; set one`,
      });
    }

    return {
      ...common,
      runtime: decoded.runtime,
      smolvm: {
        ...decoded.smolvm,
        publishAddress: decoded.smolvm.publishAddress ?? decoded.listen.address,
        ramBudgetMib,
      },
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

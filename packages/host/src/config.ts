/**
 * The host config: one JSON file, read from `clankerbox host --config PATH`. A host process
 * runs exactly one runtime, so the config names it, with that runtime's own settings.
 */
import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
  InvalidFile,
  type Runtime,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path, Schema } from "effect";
import { defaultMachinePorts, reservedPorts } from "./machine-ports.ts";
import { Address } from "./platform/address.ts";
import { type BoatHost, BoatSettings } from "./platform/boat/boat.ts";
import * as Smolvm from "./platform/smolvm.ts";
import * as Tart from "./platform/tart/tart.ts";
import type { HostSettings } from "./settings.ts";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

/** The machines' ports, both ends included, clear of every reserved range. */
const MachinePorts = Schema.Struct({ first: Port, last: Port }).check(
  Schema.makeFilter(({ first, last }) => {
    if (first > last) {
      return "first at most last";
    }

    const reserved = reservedPorts.find((range) => first <= range.last && last >= range.first);

    return (
      reserved === undefined ||
      `must stay out of ${reserved.first}-${reserved.last}, ${reserved.owner}`
    );
  }),
);

/** What every host config holds, whatever its runtime. */
const common = {
  id: HostId,
  listen: Schema.Struct({ address: Address, port: Port }),
  /** Relative to the config file. */
  stateDir: Schema.String,
  /** Base name to image. Hosts that offer the same image use the same name. */
  bases: Schema.Record(Schema.String, Schema.String),
  /** Where machines' host ports come from. Default: 10000–19999. */
  machinePorts: Schema.optionalKey(MachinePorts),
};

/**
 * Each runtime's section of the file, under the SDK's name for the runtime, so a runtime the SDK
 * names and the host config lacks fails to type-check.
 */
const sections = {
  smolvm: Smolvm.SmolvmSettings,
  tart: Tart.TartSettings,
  boat: BoatSettings,
} satisfies Record<Runtime, Schema.Struct<Schema.Struct.Fields>>;

const HostConfigFile = Schema.Union([
  Schema.Struct({ ...common, runtime: Schema.Literal("smolvm"), smolvm: sections.smolvm }),
  Schema.Struct({ ...common, runtime: Schema.Literal("tart"), tart: sections.tart }),
  Schema.Struct({ ...common, runtime: Schema.Literal("boat"), boat: sections.boat }),
]);

type HostConfigFile = typeof HostConfigFile.Type;

/** The host config as the host uses it: paths resolved and defaults applied. */
export type HostConfig = Smolvm.SmolvmHost | Tart.TartHost | BoatHost;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostConfigFile));

/** Applies defaults and resolves `stateDir` against the config file's directory. */
const resolveConfig = (
  decoded: HostConfigFile,
  directory: string,
): Effect.Effect<HostConfig, Invalid, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const machinePorts = decoded.machinePorts ?? defaultMachinePorts;
    const { port } = decoded.listen;

    // On every runtime: the tailnet is the API's only gate, so a policy that opens the machines'
    // range to the clients that run `clankerbox ssh` would open an API port inside it to them
    // too. That holds for a boat host, which publishes no machine ports: in production it shares
    // the Linux host's tailnet address with the smolvm host, whose range such a policy opens.
    // The API never takes a port a machine would be given, either.
    if (port >= machinePorts.first && port <= machinePorts.last) {
      return yield* new Invalid({
        message: `listen.port ${port}: must lie outside ${machinePorts.first}-${machinePorts.last}, the machines' range`,
      });
    }

    const common = {
      id: decoded.id,
      listen: decoded.listen,
      stateDir: path.resolve(directory, decoded.stateDir),
      bases: new Map(Object.entries(decoded.bases)),
      machinePorts,
    } satisfies Omit<HostSettings, "runtime">;

    if (decoded.runtime === "boat") {
      return { ...common, runtime: decoded.runtime, boat: decoded.boat };
    }

    if (decoded.runtime === "tart") {
      return {
        ...common,
        runtime: decoded.runtime,
        tart: Tart.resolveSettings(decoded.tart, decoded.listen),
      };
    }

    return {
      ...common,
      runtime: decoded.runtime,
      smolvm: yield* Smolvm.resolveSettings(decoded.smolvm, decoded.listen),
    };
  });

/** Reads and decodes the config file at `file`. Unknown keys are refused, as in every input. */
export const loadConfig = (
  file: string,
): Effect.Effect<HostConfig, InvalidFile, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(file);

    const text = yield* fs.readFileString(resolved).pipe(
      Effect.mapError(
        (error) =>
          new InvalidFile({
            message: `couldn't read host config ${resolved}: ${describeFileError(error)}`,
            file: resolved,
          }),
      ),
    );

    const decoded = yield* decodeConfig(text, { onExcessProperty: "error", errors: "all" }).pipe(
      Effect.mapError(
        (error) =>
          new InvalidFile({
            message: `host config ${resolved}: ${describeIssues(error)}`,
            file: resolved,
          }),
      ),
    );

    return yield* resolveConfig(decoded, path.dirname(resolved)).pipe(
      Effect.mapError(
        (error) =>
          new InvalidFile({ message: `host config ${resolved}: ${error.message}`, file: resolved }),
      ),
    );
  });

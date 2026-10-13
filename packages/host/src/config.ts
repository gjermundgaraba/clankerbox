import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
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

const common = {
  id: HostId,
  listen: Schema.Struct({ address: Address, port: Port }),
  stateDir: Schema.String,
  bases: Schema.Record(Schema.String, Schema.String),
  machinePorts: Schema.optionalKey(MachinePorts),
};

// Keyed by the SDK's runtime names, so one the SDK names and this table lacks is a type error.
// `HostConfigFile`, `HostConfig`, `resolveConfig` and `runtimes.ts` follow it by hand.
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

export type HostConfig = Smolvm.SmolvmHost | Tart.TartHost | BoatHost;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostConfigFile));

const resolveConfig = (
  decoded: HostConfigFile,
  directory: string,
): Effect.Effect<HostConfig, Invalid, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const machinePorts = decoded.machinePorts ?? defaultMachinePorts;
    const { port } = decoded.listen;

    // The tailnet is the API's only gate, so a policy that opens the machines' range to the
    // clients would open an API port inside it too. That holds for boat, which publishes no
    // machine ports: in production it shares the smolvm host's tailnet address and range.
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

export const loadConfig = (
  file: string,
): Effect.Effect<HostConfig, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(file);

    const text = yield* fs.readFileString(resolved).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read host config ${resolved}: ${describeFileError(error)}`,
            file: resolved,
          }),
      ),
    );

    const decoded = yield* decodeConfig(text, { onExcessProperty: "error", errors: "all" }).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `host config ${resolved}: ${describeIssues(error)}`,
            file: resolved,
          }),
      ),
    );

    return yield* resolveConfig(decoded, path.dirname(resolved)).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({ message: `host config ${resolved}: ${error.message}`, file: resolved }),
      ),
    );
  });

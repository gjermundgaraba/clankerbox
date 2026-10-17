import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
  type Runtime,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path, Schema } from "effect";
import { defaultMachinePorts, reservedPorts } from "../machine-ports.ts";
import { Address } from "../platform/address.ts";
import { BoatSettings } from "../platform/boat/boat.ts";
import { SmolvmSettings } from "../platform/smolvm.ts";
import { TailnetSettings } from "../platform/tailscale.ts";
import { TartSettings } from "../platform/tart/tart.ts";
import { defaultRecheck, type HostSettings } from "../settings.ts";

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
  tailnet: Schema.optionalKey(TailnetSettings),
};

const sections = {
  smolvm: SmolvmSettings,
  tart: TartSettings,
  boat: BoatSettings,
} satisfies Record<Runtime, Schema.Struct<Schema.Struct.Fields>>;

const HostConfigFile = Schema.Union([
  Schema.Struct({ ...common, runtime: Schema.Literal("smolvm"), smolvm: sections.smolvm }),
  Schema.Struct({ ...common, runtime: Schema.Literal("tart"), tart: sections.tart }),
  Schema.Struct({ ...common, runtime: Schema.Literal("boat"), boat: sections.boat }),
]);

type HostConfigFile = typeof HostConfigFile.Type;

true satisfies [Runtime] extends [HostConfigFile["runtime"]] ? true : false;

type Resolved<C> = C extends unknown
  ? Omit<C, Exclude<keyof HostSettings, "runtime">> & Omit<HostSettings, "runtime">
  : never;

/** One runtime's section, beside the settings every runtime shares. */
export type HostConfig = Resolved<HostConfigFile>;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostConfigFile));

const resolveConfig = (
  decoded: HostConfigFile,
  directory: string,
): Effect.Effect<HostConfig, Invalid, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const machinePorts = decoded.machinePorts ?? defaultMachinePorts;
    const { port } = decoded.listen;

    if (port >= machinePorts.first && port <= machinePorts.last) {
      return yield* new Invalid({
        message: `listen.port ${port}: must lie outside ${machinePorts.first}-${machinePorts.last}, the machines' range`,
      });
    }

    return {
      ...decoded,
      stateDir: path.resolve(directory, decoded.stateDir),
      bases: new Map(Object.entries(decoded.bases)),
      machinePorts,
      recheck: defaultRecheck,
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

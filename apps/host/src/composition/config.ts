import { isImageReference } from "@clankerbox/host-contract/traits";
import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
  Port,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Caller, Tls } from "@gjermundgaraba/clankerbox-sdk/node";
import {
  AnyAddress,
  listenRefusal,
  readCallers,
  readTls,
  TlsFiles,
} from "@gjermundgaraba/clankerbox-sdk/node";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { Box } from "../box.ts";
import { defaultMachinePorts } from "../settings.ts";
import type { HostSettings } from "../settings.ts";
import { isRuntimeKey, runtimes, settingsOf } from "./runtimes.ts";
import type { ChosenRuntime, RuntimeKey } from "./runtimes.ts";

const MachinePorts = Schema.Struct({ first: Port, last: Port }).check(
  Schema.makeFilter(({ first, last }) => first <= last || "first at most last")
);

const common = {
  id: HostId,
  listen: Schema.Struct({ address: AnyAddress, port: Port }),
  publish: Schema.optionalKey(Schema.Struct({ address: AnyAddress })),
  stateDir: Schema.String,
  bases: Schema.Record(Schema.String, Schema.String).check(
    Schema.makeFilter((bases) => {
      const reference = Object.keys(bases).find(isImageReference);

      return (
        reference === undefined ||
        `a base name holds no /, which marks an image reference: ${reference}`
      );
    })
  ),
  machinePorts: Schema.optionalKey(MachinePorts),
  tailnet: Schema.optionalKey(Schema.Boolean),
  callers: Schema.optionalKey(Schema.String),
  tls: Schema.optionalKey(TlsFiles),
};

const HostConfigFile = Schema.Struct({
  ...common,
  runtime: Schema.Record(Schema.String, Schema.Unknown),
});

type HostConfigFile = typeof HostConfigFile.Type;

export interface HostConfig extends HostSettings {
  readonly runtime: ChosenRuntime;
  /** The control planes it takes, by token; none, or left out, takes every caller, as before 0.44. */
  readonly callers?: readonly Caller[] | undefined;
  readonly tls?: Tls | undefined;
}

const strictly = { onExcessProperty: "error", errors: "all" } as const;

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HostConfigFile)
);

const SaysKind = Schema.fromJsonString(Schema.Struct({ kind: Schema.Unknown }));

const names = Object.keys(runtimes).join(", ");

const kindMoved = `; "kind" and its block are now "runtime", an object naming one runtime, one of ${names}, with that block's settings: { "runtime": { "<name>": { ... } } }`;

const chosen = <K extends RuntimeKey>(
  name: K,
  settings: unknown
): Effect.Effect<ChosenRuntime<K>, Invalid> =>
  Schema.decodeUnknownEffect(settingsOf(name))(settings, strictly).pipe(
    Effect.map((decoded) => ({ name, settings: decoded })),
    Effect.mapError(
      (error) =>
        new Invalid({ message: `runtime.${name}: ${describeIssues(error)}` })
    )
  );

const chosenRuntime = (
  runtime: HostConfigFile["runtime"]
): Effect.Effect<ChosenRuntime, Invalid> => {
  const named = Object.entries(runtime);
  const [first] = named;

  if (first === undefined || named.length > 1) {
    return Effect.fail(
      new Invalid({
        message: `runtime: names exactly one runtime, one of ${names}, and this names ${named.length}`,
      })
    );
  }

  const [name, settings] = first;

  return isRuntimeKey(name)
    ? chosen(name, settings)
    : Effect.fail(
        new Invalid({
          message: `runtime: ${name} is no runtime this host drives, which are ${names}`,
        })
      );
};

const resolveConfig = (
  decoded: HostConfigFile,
  directory: string
): Effect.Effect<
  HostConfig,
  Invalid,
  FileSystem.FileSystem | Path.Path | Box
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const relative = (given: string) => path.resolve(directory, given);
    const { ephemeralPorts } = yield* Box;
    const runtime = yield* chosenRuntime(decoded.runtime);
    const machinePorts = decoded.machinePorts ?? defaultMachinePorts;
    const { port } = decoded.listen;

    const refused = listenRefusal("listen.address", decoded.listen.address, {
      callers: decoded.callers !== undefined,
      tls: decoded.tls !== undefined,
    });

    if (refused !== undefined) {
      return yield* new Invalid({ message: refused });
    }

    if (
      machinePorts.first <= ephemeralPorts.last &&
      machinePorts.last >= ephemeralPorts.first
    ) {
      return yield* new Invalid({
        message: `machinePorts: must stay out of ${ephemeralPorts.first}-${ephemeralPorts.last}, ${ephemeralPorts.owner}`,
      });
    }

    if (port >= machinePorts.first && port <= machinePorts.last) {
      return yield* new Invalid({
        message: `listen.port ${port}: must lie outside ${machinePorts.first}-${machinePorts.last}, the machines' range`,
      });
    }

    const { callers, tls, ...rest } = decoded;

    return {
      ...rest,
      runtime,
      stateDir: relative(decoded.stateDir),
      bases: new Map(Object.entries(decoded.bases)),
      machinePorts,
      ...(callers === undefined
        ? {}
        : { callers: yield* readCallers(relative(callers)) }),
      ...(tls === undefined ? {} : { tls: yield* readTls(tls, relative) }),
    };
  });

export const loadConfig = (
  file: string
): Effect.Effect<
  HostConfig,
  Invalid,
  FileSystem.FileSystem | Path.Path | Box
> =>
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
          })
      )
    );

    const decoded = yield* decodeConfig(text, strictly).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `host config ${resolved}: ${describeIssues(error)}${Option.isSome(Schema.decodeOption(SaysKind)(text)) ? kindMoved : ""}`,
            file: resolved,
          })
      )
    );

    return yield* resolveConfig(decoded, path.dirname(resolved)).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `host config ${resolved}: ${error.message}`,
            file: resolved,
          })
      )
    );
  });

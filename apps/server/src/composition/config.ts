import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
} from "@gjermundgaraba/clankerbox-sdk";
import { Address } from "@gjermundgaraba/clankerbox-sdk/node";
import { Effect, FileSystem, Path, Schema } from "effect";

import { defaultFailedRowsLast, defaultRecheck } from "../settings.ts";
import type { ServerSettings } from "../settings.ts";

const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

const ServerConfigFile = Schema.Struct({
  listen: Schema.Struct({ address: Address, port: Port }),
  stateDir: Schema.String,
  hosts: Schema.Array(
    Schema.Struct({
      id: HostId,
      url: Schema.String,
      draining: Schema.optionalKey(Schema.Boolean),
    })
  ).check(
    Schema.makeFilter((hosts) => {
      const ids = hosts.map(({ id }) => id);
      const repeated = ids.find((id, at) => ids.indexOf(id) !== at);

      return repeated === undefined || `host ${repeated} is listed twice`;
    })
  ),
});

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerConfigFile)
);

export const loadConfig = (
  file: string
): Effect.Effect<ServerSettings, Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(file);

    const text = yield* fs.readFileString(resolved).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read server config ${resolved}: ${describeFileError(error)}`,
            file: resolved,
          })
      )
    );

    const decoded = yield* decodeConfig(text, {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `server config ${resolved}: ${describeIssues(error)}`,
            file: resolved,
          })
      )
    );

    return {
      listen: decoded.listen,
      stateDir: path.resolve(path.dirname(resolved), decoded.stateDir),
      hosts: decoded.hosts.map(({ id, url, draining }) => ({
        id,
        url,
        draining: draining === true,
      })),
      recheck: defaultRecheck,
      failedRowsLast: defaultFailedRowsLast,
    };
  });

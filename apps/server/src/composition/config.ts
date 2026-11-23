import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
  Port,
  readAuthorizedKeys,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Caller, Tls } from "@gjermundgaraba/clankerbox-sdk/node";
import {
  AnyAddress,
  listenRefusal,
  readCallers,
  readTls,
  readToken,
  TlsFiles,
} from "@gjermundgaraba/clankerbox-sdk/node";
import { Effect, FileSystem, Path, Schema } from "effect";

import { TailnetSettings } from "../platform/tailscale.ts";
import {
  defaultFailedRowsLast,
  defaultHookTimeoutSeconds,
  defaultRecheck,
} from "../settings.ts";
import type { ServerSettings } from "../settings.ts";

const ServerConfigFile = Schema.Struct({
  listen: Schema.Struct({ address: AnyAddress, port: Port }),
  stateDir: Schema.String,
  authorizedKeys: Schema.String,
  callers: Schema.optionalKey(Schema.String),
  tls: Schema.optionalKey(TlsFiles),
  hookTimeout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  tailnet: Schema.optionalKey(TailnetSettings),
  hosts: Schema.Array(
    Schema.Struct({
      id: HostId,
      url: Schema.String,
      draining: Schema.optionalKey(Schema.Boolean),
      token: Schema.optionalKey(Schema.String),
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

export interface ServerConfig extends ServerSettings {
  readonly tailnet?: TailnetSettings | undefined;
  /** The callers it takes, by token; none, or left out, takes every caller, as before 0.44. */
  readonly callers?: readonly Caller[] | undefined;
  readonly tls?: Tls | undefined;
}

export const loadConfig = (
  file: string
): Effect.Effect<ServerConfig, Invalid, FileSystem.FileSystem | Path.Path> =>
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

    const relative = (given: string) =>
      path.resolve(path.dirname(resolved), given);

    const refused = listenRefusal("listen.address", decoded.listen.address, {
      callers: decoded.callers !== undefined,
      tls: decoded.tls !== undefined,
    });

    if (refused !== undefined) {
      return yield* new Invalid({
        message: `server config ${resolved}: ${refused}`,
        file: resolved,
      });
    }

    return {
      listen: decoded.listen,
      stateDir: relative(decoded.stateDir),
      hosts: yield* Effect.forEach(
        decoded.hosts,
        ({ id, url, draining, token }) =>
          Effect.map(
            token === undefined ? Effect.undefined : readToken(relative(token)),
            (read) => ({
              id,
              url,
              draining: draining === true,
              ...(read === undefined ? {} : { token: read }),
            })
          )
      ),
      recheck: defaultRecheck,
      failedRowsLast: defaultFailedRowsLast,
      authorizedKeys: yield* readAuthorizedKeys(
        relative(decoded.authorizedKeys)
      ),
      hookTimeoutSeconds: decoded.hookTimeout ?? defaultHookTimeoutSeconds,
      ...(decoded.tailnet === undefined ? {} : { tailnet: decoded.tailnet }),
      ...(decoded.callers === undefined
        ? {}
        : { callers: yield* readCallers(relative(decoded.callers)) }),
      ...(decoded.tls === undefined
        ? {}
        : { tls: yield* readTls(decoded.tls, relative) }),
    };
  });

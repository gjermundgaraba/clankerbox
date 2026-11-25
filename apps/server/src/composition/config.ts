import {
  describeFileError,
  describeIssues,
  HostId,
  Invalid,
  Port,
  readAuthorizedKeys,
  readToken,
  Client,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Tls } from "@gjermundgaraba/clankerbox-sdk/node";
import {
  AnyAddress,
  listenRefusal,
  readTls,
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
  tokens: Schema.optionalKey(Schema.Boolean),
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
  readonly tokens?: boolean | undefined;
  readonly tls?: Tls | undefined;
}

const refuseTokenUrl = (file: string, id: string, url: string) => {
  const refused = Client.tokenUrlRefusal(url);

  return refused === undefined
    ? Effect.void
    : Effect.fail(
        new Invalid({
          message: `server config ${file}: host ${id} has a token, and its url ${refused}`,
          file,
        })
      );
};

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
      tokens: decoded.tokens === true,
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
            token === undefined
              ? Effect.undefined
              : Effect.andThen(
                  refuseTokenUrl(resolved, id, url),
                  readToken(relative(token), "host")
                ),
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
      ...(decoded.tokens === true ? { tokens: true } : {}),
      ...(decoded.tls === undefined
        ? {}
        : { tls: yield* readTls(decoded.tls, relative) }),
    };
  });

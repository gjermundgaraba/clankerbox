import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import type { Socket } from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  Headers,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as Client from "./client.ts";
import { describeFileError } from "./describe.ts";
import { Invalid } from "./errors.ts";
import { isTailnetOrLoopback, tailnetOrLoopbackRule } from "./reach.ts";
import { callerNameRefusal, secretKind, tokenPrefix } from "./resources.ts";
import type { TokenKind } from "./resources.ts";

/**
 * The client over Node's `http`. It is in `./node`, apart from `.`, so an app that brings its own
 * `HttpClient` never loads `@effect/platform-node`.
 */
export const layer = (
  url: string,
  options?: Client.Options
): Layer.Layer<Client.Client, Invalid> =>
  Client.layer(url, options).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

/** Any IP address, which a config then holds to `listenRefusal`. */
export const AnyAddress = Schema.String.check(
  Schema.makeFilter((address: string) => isIP(address) !== 0 || "an IP address")
);

/**
 * Why a server may not listen on `address`, or `undefined` when it may. A tailnet or loopback
 * address is always allowed; any other only when the server authenticates its callers and serves
 * TLS, as nothing else then stops whoever reaches it, and its token would cross the network in
 * the clear. A config refuses to start on the reason, so a public address without both is never
 * served.
 */
export const listenRefusal = (
  field: string,
  address: string,
  guarded: Readonly<Record<string, boolean>>
): string | undefined => {
  if (isTailnetOrLoopback(address)) {
    return undefined;
  }

  const lacking = Object.entries(guarded)
    .filter(([, set]) => !set)
    .map(([name]) => name);

  return lacking.length === 0
    ? undefined
    : `${field} ${address} is not ${tailnetOrLoopbackRule}, so it needs ${lacking.join(" and ")} set too: without them anyone who reaches it can act on every machine, and tokens would cross the network in the clear`;
};

/** A server's TLS: its certificate chain and key, as PEM. */
export interface Tls {
  readonly cert: string;
  readonly key: string;
}

export const TlsFiles = Schema.Struct({
  cert: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
});

/** Reads a config's `tls` files, each path resolved by `resolve`. */
export const readTls = (
  files: typeof TlsFiles.Type,
  resolve: (path: string) => string
): Effect.Effect<Tls, Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = (what: "cert" | "key") => {
      const path = resolve(files[what]);

      return fs.readFileString(path).pipe(
        Effect.mapError(
          (error) =>
            new Invalid({
              message: `couldn't read tls.${what} ${path}: ${describeFileError(error)}`,
              file: path,
            })
        )
      );
    };

    return { cert: yield* read("cert"), key: yield* read("key") };
  });

class ClosingHttp extends HttpServer {
  override close(callback?: (error?: Error) => void) {
    super.close(callback);
    this.closeAllConnections();

    return this;
  }
}

class ClosingHttps extends HttpsServer {
  readonly sockets = new Set<Socket>();

  constructor(options: { readonly cert: string; readonly key: string }) {
    super(options);
    this.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => {
        this.sockets.delete(socket);
      });
    });
  }

  override close(callback?: (error?: Error) => void) {
    super.close(callback);

    for (const socket of this.sockets) {
      socket.destroy();
    }

    return this;
  }
}

/**
 * The Node server a control plane or host listens on, over TLS when given `tls`, which closes
 * every connection it still holds as it closes: Node's own close closes the idle ones and waits
 * on the rest, on one whose request never completes for good. An https.Server is typed apart
 * from an http.Server, but serves `request` as one does, which is all NodeHttpServer uses of it.
 */
export const closingServer = (tls: Tls | undefined): HttpServer =>
  tls === undefined
    ? new ClosingHttp()
    : new ClosingHttps({
        cert: tls.cert,
        key: tls.key,
      });

/** A caller a server takes, by the name its token file gives it, and its token's SHA-256. */
export interface Caller {
  readonly name: string;
  readonly hash: Uint8Array;
}

const sha256Hex = /^[0-9a-f]{64}$/u;

export const hashToken = (token: string): Uint8Array =>
  createHash("sha256").update(token, "utf8").digest();

/**
 * A new token for `kind`'s hop, its prefix then 32 random bytes as hex, its SHA-256, and the line
 * a callers file takes for it under `name`.
 */
export const mintToken = (kind: TokenKind, name: string) => {
  const token = `${tokenPrefix[kind]}${randomBytes(32).toString("hex")}`;
  const hash = hashToken(token);

  return {
    token: Redacted.make(token),
    hash,
    line: `${name} ${Buffer.from(hash).toString("hex")}`,
  };
};

/**
 * Parses the text of a callers file at `path`: a line `<name> <sha256 of the token, hex>` per
 * caller, blank lines and `#` comments skipped. A name twice, a hash twice, or any other line is
 * `Invalid`, naming the line, so a typo is refused at start rather than met as a refused caller.
 */
export const parseCallers = (
  path: string,
  text: string
): Effect.Effect<readonly Caller[], Invalid> =>
  Effect.gen(function* () {
    const callers: Caller[] = [];
    const lines = text.replaceAll("\r\n", "\n").split("\n");

    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();

      if (line === "" || line.startsWith("#")) {
        continue;
      }

      const refuse = (why: string) =>
        new Invalid({
          message: `callers ${path}, line ${index + 1}: ${why}`,
          file: path,
        });

      const [name, hash, ...rest] = line.split(/\s+/u);

      if (name === undefined || hash === undefined || rest.length > 0) {
        return yield* refuse(
          "each line is `<name> <sha256 of the token, hex>`: make one with `clankerbox-server token add <name>`"
        );
      }

      const misnamed = callerNameRefusal(name);

      if (misnamed !== undefined) {
        return yield* refuse(misnamed);
      }

      if (secretKind(hash) === "caller" || secretKind(hash) === "host") {
        return yield* refuse(
          `${name}'s line holds a token, not its SHA-256; the file holds each token's SHA-256, never the token: make the line with \`clankerbox-server token add <name> --callers\``
        );
      }

      if (!sha256Hex.test(hash)) {
        return yield* refuse(
          `${name}'s hash is not 64 lowercase hex digits; the file holds each token's SHA-256, never the token`
        );
      }

      if (callers.some((caller) => caller.name === name)) {
        return yield* refuse(`${name} is named twice`);
      }

      const bytes = Buffer.from(hash, "hex");

      if (callers.some((caller) => Buffer.compare(caller.hash, bytes) === 0)) {
        return yield* refuse(`${name}'s hash is another caller's too`);
      }

      callers.push({ name, hash: bytes });
    }

    return callers;
  });

/** Reads and parses a callers file, refusing one that names no caller, which would refuse everyone. */
export const readCallers = (
  path: string
): Effect.Effect<readonly Caller[], Invalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({
            message: `couldn't read callers ${path}: ${describeFileError(error)}`,
            file: path,
          })
      )
    );

    const callers = yield* parseCallers(path, text);

    if (callers.length === 0) {
      return yield* new Invalid({
        message: `callers ${path} names no caller, so it would refuse everyone: add one with \`clankerbox-server token add <name>\``,
        file: path,
      });
    }

    return callers;
  });

/**
 * The caller whose token this is, or none, found by comparing the token's SHA-256 with every
 * caller's through `timingSafeEqual`, so the time taken is the same whichever byte or caller differs.
 */
export const callerInConstantTime = (
  callers: readonly Caller[],
  token: string
): Caller | undefined => {
  const presented = hashToken(token);
  let found: Caller | undefined;

  for (const caller of callers) {
    if (timingSafeEqual(presented, caller.hash) && found === undefined) {
      found = caller;
    }
  }

  return found;
};

const bearer = /^Bearer[ \t]+(?<token>\S+)[ \t]*$/iu;

/** The token of a request's `Authorization: Bearer` header, or none. */
export const bearerToken = (headers: Headers.Headers): Option.Option<string> =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) =>
    Option.fromNullishOr(bearer.exec(value)?.groups?.["token"])
  );

/** The caller `requireToken` found a request's token to be; none where it takes every caller. */
export const CurrentCaller = Context.Reference<Caller | undefined>(
  "@gjermundgaraba/clankerbox-sdk/node/CurrentCaller",
  { defaultValue: () => undefined }
);

const encodeUnauthenticated = Schema.encodeSync(Action.Unauthenticated);

const refused = (message: string) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      encodeUnauthenticated(new Action.Unauthenticated({ message })),
      { status: 401, headers: { "www-authenticate": "Bearer" } }
    )
  );

/**
 * Refuses, for a server of either contract, a request whose `Authorization: Bearer` token is no
 * caller's, before it reads anything, as effect-actions' `Unauthenticated` at 401, and runs the
 * rest as `CurrentCaller`. It reads `callers` for each request, so a caller taken away is refused
 * from the next one. Given none it passes every request, as a server whose config names no callers
 * takes every caller, the tailnet or loopback its listen address is limited to being its only gate.
 */
export const requireToken = (
  server: string,
  callers: Effect.Effect<readonly Caller[]> | undefined
) =>
  HttpRouter.middleware((handle) =>
    callers === undefined
      ? handle
      : Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          Option.match(bearerToken(request.headers), {
            onNone: () =>
              refused(
                `this ${server} takes only a caller with a token, and this request carries none`
              ),
            onSome: (token) =>
              Effect.flatMap(callers, (taken) => {
                const caller = callerInConstantTime(taken, token);

                return caller === undefined
                  ? refused(`this ${server} takes no caller with this token`)
                  : Effect.provideService(handle, CurrentCaller, caller);
              }),
          })
        )
  );

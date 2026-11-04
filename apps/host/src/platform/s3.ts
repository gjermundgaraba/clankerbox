import { createHash, createHmac } from "node:crypto";
import type { BinaryLike } from "node:crypto";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpMethod } from "effect/http";

import { BuildStore } from "../builds.ts";

const nonEmpty = Schema.String.check(Schema.isNonEmpty());

export const BuildsSettings = Schema.Struct({
  endpoint: Schema.String.check(
    Schema.isPattern(/^https?:\/\/[^/?#@]+$/u, {
      message:
        "an http(s) URL with no path and no credentials, such as http://127.0.0.1:8333",
    })
  ),
  bucket: nonEmpty,
  region: nonEmpty,
  accessKeyId: nonEmpty,
  secretAccessKey: Schema.RedactedFromValue(nonEmpty),
});

export type BuildsSettings = typeof BuildsSettings.Type;

const unsignedPayload = "UNSIGNED-PAYLOAD";

const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

const removeConcurrency = 16;

// https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
const uriEncode = (value: string) =>
  encodeURIComponent(value).replaceAll(
    /[!'()*]/gu,
    (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: BinaryLike, value: string) =>
  createHmac("sha256", key).update(value).digest();

const amzDate = (now: DateTime.Utc) =>
  DateTime.formatIso(now).replaceAll(/[-:]|\.\d{3}/gu, "");

const namedEntities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

const decodeXml = (text: string) =>
  text.replaceAll(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity) => {
    const name = entity.slice(1, -1);

    if (/^#x/iu.test(name)) {
      return String.fromCodePoint(Number(`0x${name.slice(2)}`));
    }

    if (name.startsWith("#")) {
      return String.fromCodePoint(Number(name.slice(1)));
    }

    return namedEntities.get(name) ?? entity;
  });

const elements = (xml: string, name: string) =>
  Array.from(
    xml.matchAll(new RegExp(`<${name}>(?<text>[^<]*)</${name}>`, "gu")),
    (match) => decodeXml(match.groups?.["text"] ?? "")
  );

interface Call {
  readonly what: string;
  readonly method: HttpMethod.HttpMethod;
  readonly key?: string;
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly body?: Uint8Array;
  readonly ok?: (status: number) => boolean;
}

const success = (status: number) => status >= 200 && status < 300;

export const make = (
  settings: BuildsSettings
): Effect.Effect<BuildStore["Service"], never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    const { host } = new URL(settings.endpoint);

    const scope = (date: string) =>
      `${date.slice(0, 8)}/${settings.region}/s3/aws4_request`;

    const signature = (date: string, canonical: string) => {
      const dateKey = hmac(
        `AWS4${Redacted.value(settings.secretAccessKey)}`,
        date.slice(0, 8)
      );

      const regionKey = hmac(dateKey, settings.region);

      const serviceKey = hmac(regionKey, "s3");

      const signingKey = hmac(serviceKey, "aws4_request");

      const toSign = [
        "AWS4-HMAC-SHA256",
        date,
        scope(date),
        sha256(canonical),
      ].join("\n");

      return createHmac("sha256", signingKey).update(toSign).digest("hex");
    };

    const send = (call: Call) =>
      Effect.gen(function* () {
        const path = `/${[settings.bucket, ...(call.key?.split("/") ?? [])].map(uriEncode).join("/")}`;

        const query = (call.query ?? [])
          .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
          .toSorted()
          .join("&");

        const date = amzDate(yield* DateTime.now);

        const canonical = [
          call.method,
          path,
          query,
          `host:${host}`,
          `x-amz-content-sha256:${unsignedPayload}`,
          `x-amz-date:${date}`,
          "",
          signedHeaders,
          unsignedPayload,
        ].join("\n");

        const urlAsSigned = `${settings.endpoint}${path}${query === "" ? "" : `?${query}`}`;

        const request = HttpClientRequest.make(call.method)(urlAsSigned).pipe(
          HttpClientRequest.setHeaders({
            authorization: `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope(date)}, SignedHeaders=${signedHeaders}, Signature=${signature(date, canonical)}`,
            "x-amz-content-sha256": unsignedPayload,
            "x-amz-date": date,
          }),
          call.body === undefined
            ? (unchanged) => unchanged
            : HttpClientRequest.bodyUint8Array(call.body)
        );

        const response = yield* http.execute(request);

        if (!(call.ok ?? success)(response.status)) {
          const [code] = elements(yield* response.text, "Code");

          return yield* new Internal({
            message: `S3 ${call.what} answered ${response.status}${code === undefined ? "" : ` ${code}`}`,
          });
        }

        return new Uint8Array(yield* response.arrayBuffer);
      }).pipe(
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(
            new Internal({ message: `S3 ${call.what}: ${error.message}` })
          )
        )
      );

    const list = (prefix: string) =>
      Effect.gen(function* () {
        const keys: string[] = [];
        let token: string | undefined;

        do {
          const page = new TextDecoder().decode(
            yield* send({
              what: `ListObjectsV2 of ${prefix}`,
              method: "GET",
              query: [
                ["list-type", "2"],
                ["prefix", prefix],
                ...(token === undefined
                  ? []
                  : [["continuation-token", token] as const]),
              ],
            })
          );

          keys.push(...elements(page, "Key"));

          token =
            elements(page, "IsTruncated")[0] === "true"
              ? elements(page, "NextContinuationToken")[0]
              : undefined;
        } while (token !== undefined);

        return keys;
      });

    const get = (key: string) =>
      send({ what: `GetObject of ${key}`, method: "GET", key });

    const put = (key: string, body: Uint8Array) =>
      Effect.asVoid(
        send({ what: `PutObject of ${key}`, method: "PUT", key, body })
      );

    const remove = (keys: readonly string[]) =>
      Effect.forEach(
        keys,
        (key) =>
          send({
            what: `DeleteObject of ${key}`,
            method: "DELETE",
            key,
            ok: (status) => success(status) || status === 404,
          }),
        { concurrency: removeConcurrency, discard: true }
      );

    return { list, get, put, remove };
  });

export const layer = (
  settings: BuildsSettings
): Layer.Layer<BuildStore, never, HttpClient.HttpClient> =>
  Layer.effect(BuildStore, make(settings));

import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { describeFileError, describeIssues, formatMib } from "../src/index.ts";

it("a RAM size reads exactly: in GiB when whole or half GiB, and in MiB when not", () => {
  expect([512, 1024, 1500, 1536, 4097, 32_768, 126_608].map(formatMib)).toEqual([
    "512M",
    "1G",
    "1500M",
    "1.5G",
    "4097M",
    "32G",
    "126608M",
  ]);
});

const Config = Schema.Struct({
  hosts: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
  cpu: Schema.Int.check(Schema.isGreaterThan(0)),
});

const refused = (json: string, names?: ReadonlyMap<PropertyKey, string>) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Config))(json, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    Effect.flip,
    Effect.map((error) => describeIssues(error, names)),
  );

it.effect("a decode's failures read one a field, each under its JSON path", () =>
  Effect.gen(function* () {
    expect(yield* refused('{"hosts":[{"id":"linux"}],"cpu":0,"ram":1}')).toBe(
      "ram: not a known field; hosts[0].url: missing; cpu: Expected a value greater than 0",
    );
    expect(yield* refused("{")).toBe("Expected a valid JSON string");
  }),
);

it.effect("a decode's failures call a top-level field what its caller does", () =>
  Effect.gen(function* () {
    expect(yield* refused('{"hosts":[{"id":"linux"}]}', new Map([["cpu", "--cpu"]]))).toBe(
      "hosts[0].url: missing; --cpu: missing",
    );
  }),
);

it.effect("a file failure says why, without the platform call that met it", () =>
  Effect.gen(function* () {
    const failed = (path: string) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(path)),
        Effect.flip,
        Effect.map(describeFileError),
      );

    expect(yield* failed(join(tmpdir(), "clankerbox-no-such-file"))).toBe(
      "no such file or directory",
    );
    expect(yield* failed(tmpdir())).toContain("EISDIR: illegal operation on a directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

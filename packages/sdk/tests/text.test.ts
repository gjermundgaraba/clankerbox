import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { describeFileError, describeIssues, formatMib } from "../src/index.ts";

test("a RAM size reads exactly: in GiB when whole or half GiB, and in MiB when not", () => {
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
    Effect.runSync,
  );

test("a decode's failures read one a field, each under its JSON path", () => {
  expect(refused('{"hosts":[{"id":"linux"}],"cpu":0,"ram":1}')).toBe(
    "ram: not a known field; hosts[0].url: missing; cpu: Expected a value greater than 0",
  );
  expect(refused("{")).toBe("Expected a valid JSON string");
});

test("a decode's failures call a top-level field what its caller does", () => {
  expect(refused('{"hosts":[{"id":"linux"}]}', new Map([["cpu", "--cpu"]]))).toBe(
    "hosts[0].url: missing; --cpu: missing",
  );
});

test("a file failure says why, without the platform call that met it", async () => {
  const failed = (path: string) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.readFileString(path)),
      Effect.flip,
      Effect.map(describeFileError),
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );

  expect(await failed(join(tmpdir(), "clankerbox-no-such-file"))).toBe("no such file or directory");
  // Node describes a failure only in its cause, which is what a failure with no wording reads as.
  expect(await failed(tmpdir())).toContain("EISDIR: illegal operation on a directory");
});

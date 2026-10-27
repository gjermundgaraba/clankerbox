import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";

import { describeFileError, describeIssues } from "../src/index.ts";

const Config = Schema.Struct({
  hosts: Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String })),
  cpu: Schema.Int.check(Schema.isGreaterThan(0)),
});

const refused = (json: string, names?: ReadonlyMap<PropertyKey, string>) =>
  Schema.decodeEffect(Schema.fromJsonString(Config))(json, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    Effect.flip,
    Effect.map((error) => describeIssues(error, names))
  );

it.effect(
  "a decode's failures read one a field, each under its JSON path",
  () =>
    Effect.gen(function* () {
      expect(yield* refused('{"hosts":[{"id":"linux"}],"cpu":0,"ram":1}')).toBe(
        "ram: not a known field; hosts[0].url: missing; cpu: Expected a value greater than 0"
      );
      expect(yield* refused("{")).toBe("Expected a valid JSON string");
    })
);

it.effect(
  "a decode's failures call a top-level field what its caller does",
  () =>
    Effect.gen(function* () {
      expect(
        yield* refused(
          '{"hosts":[{"id":"linux"}]}',
          new Map([["cpu", "--cpu"]])
        )
      ).toBe("hosts[0].url: missing; --cpu: missing");
    })
);

const failed = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.flip,
    Effect.map(describeFileError)
  );

it.effect(
  "a file failure says why, without the platform call that met it",
  () =>
    Effect.gen(function* () {
      expect(
        yield* failed(path.join(tmpdir(), "clankerbox-no-such-file"))
      ).toBe("no such file or directory");
      expect(yield* failed(tmpdir())).toContain(
        "EISDIR: illegal operation on a directory"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

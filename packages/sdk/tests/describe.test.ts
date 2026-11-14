import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  CreateRequest,
  describeFileError,
  describeIssues,
} from "../src/index.ts";

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

it.effect(
  "a create's failures are those of the template or the base it names, once, in either decode mode",
  () =>
    Effect.gen(function* () {
      const said = yield* Effect.forEach(
        [
          { id: "dev", base: "ubuntu", cpu: 0, ramMib: 1024, diskGib: 10 },
          { id: "dev", template: "web", cpu: 0 },
          { id: "2dev", base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 },
          { id: "dev" },
        ],
        (input) =>
          Effect.forEach(["all", "first"] as const, (errors) =>
            Schema.decodeEffect(CreateRequest)(input, { errors }).pipe(
              Effect.flip,
              Effect.map((error) => describeIssues(error))
            )
          )
      );

      const name =
        "id: a name is 1 to 62 characters: it starts with a letter, then letters, digits and '-', with no '--' and no '-' at the end";

      expect(said).toStrictEqual([
        Array.from({ length: 2 }, () => "cpu: Expected a value greater than 0"),
        Array.from({ length: 2 }, () => "cpu: Expected a value greater than 0"),
        [name, name],
        Array.from({ length: 2 }, () => "a create names a template or a base"),
      ]);
    })
);

it.effect(
  "a create read as the server reads it, refusing unknown fields, says what is wrong with the one it names, once, in either decode mode",
  () =>
    Effect.gen(function* () {
      const sizes = { cpu: 1, ramMib: 1024, diskGib: 10 };

      const said = yield* Effect.forEach(
        [
          { id: "dev", template: "web", base: "ubuntu", ...sizes },
          { id: "dev", base: "ubuntu", ...sizes, extra: 1 },
          { id: 5, base: "ubuntu", ...sizes },
          { id: "dev", base: "ubuntu", cpu: 1, ramMib: 1024 },
          { id: 5 },
        ],
        (input) =>
          Effect.forEach(["all", "first"] as const, (errors) =>
            Schema.decodeEffect(CreateRequest)(input, {
              errors,
              onExcessProperty: "error",
            }).pipe(
              Effect.flip,
              Effect.map((error) => describeIssues(error))
            )
          )
      );

      expect(said).toStrictEqual(
        [
          "base: not a known field",
          "extra: not a known field",
          "id: Expected string",
          "diskGib: missing",
          "a create names a template or a base",
        ].map((one) => [one, one])
      );
    })
);

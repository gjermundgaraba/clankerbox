import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Path, Schema } from "effect";
import { expect } from "vite-plus/test";

import { outputOf, scratch, write } from "./files.ts";

const recorder = `
import { registerHooks } from "node:module";

const entry = process.argv[2];
const builtins = new Set();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);

    if (resolved.url.startsWith("node:")) {
      builtins.add(resolved.url);
    }

    return resolved;
  },
});

await import(entry);
console.log(JSON.stringify([...builtins]));
`;

const decodeBuiltins = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String))
);

const builtinsOf = (entry: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dir = yield* scratch;
    const script = path.join(dir, "record.mjs");
    const source = new URL(entry, import.meta.url);

    yield* write(script, recorder);

    const { code, stdout, stderr } = yield* outputOf("node", [
      "--no-warnings",
      script,
      source.href,
    ]);

    expect(code, stderr).toBe(0);

    return yield* decodeBuiltins(stdout);
  });

layer(NodeServices.layer)((it) => {
  it.effect("the `.` entry asks for no Node module, however deep", () =>
    Effect.gen(function* () {
      expect(yield* builtinsOf("../src/index.ts")).toStrictEqual([]);
    })
  );

  it.effect("the check sees a Node module: the `./node` entry takes some", () =>
    Effect.gen(function* () {
      expect(yield* builtinsOf("../src/node.ts")).toContain("node:http");
    })
  );
});

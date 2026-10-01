// q-sea-min: a trivial Effect program, bundled by esbuild into one file, to see
// whether a realistic bundle changes SEA build, size or startup.
import { Console, Effect, Schema } from "effect";
import { isSea } from "node:sea";
import { DatabaseSync } from "node:sqlite";

const Row = Schema.Struct({ v: Schema.Number, version: Schema.String });

const program = Effect.gen(function* () {
  const role = process.argv[2] ?? "cli";
  const raw = yield* Effect.sync(() => {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("select 42 as v, sqlite_version() as version").get();
    db.close();
    return { ...row };
  });
  const row = yield* Schema.decodeUnknownEffect(Row)(raw);
  yield* Console.log(JSON.stringify({ role, effect: true, isSea: isSea(), node: process.version, row }));
});

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exit(1);
});

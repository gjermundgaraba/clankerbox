import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  callerInConstantTime,
  readCallers,
} from "@gjermundgaraba/clankerbox-sdk/node";
import {
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Redacted } from "effect";
import { expect } from "vite-plus/test";

import { addCaller } from "../../src/composition/token.ts";

layer(NodeServices.layer)((it) => {
  it.effect(
    "token add makes the callers file, appends each caller's hash, and the control plane takes each printed token as its caller",
    () =>
      Effect.gen(function* () {
        const file = path.join(yield* scratch, "callers");
        const laptop = yield* addCaller(file, "laptop");
        const orbs = yield* addCaller(file, "orbs");
        const callers = yield* readCallers(file);

        expect(callers.map(({ name }) => name)).toStrictEqual([
          "laptop",
          "orbs",
        ]);
        expect(
          callerInConstantTime(callers, Redacted.value(laptop))?.name
        ).toBe("laptop");
        expect(callerInConstantTime(callers, Redacted.value(orbs))?.name).toBe(
          "orbs"
        );
        expect(yield* read(file)).not.toContain(Redacted.value(laptop));
      })
  );

  it.effect(
    "token add keeps what the file held, a last line without its newline and comments included",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const commented = path.join(dir, "commented");
        const unended = path.join(dir, "unended");

        yield* write(commented, "# the laptops\n");
        yield* addCaller(commented, "laptop");

        const first = yield* addCaller(unended, "laptop");
        const kept = yield* read(unended);

        yield* write(unended, kept.trimEnd());
        yield* addCaller(unended, "orbs");

        expect(yield* read(commented)).toMatch(
          /^# the laptops\nlaptop [0-9a-f]{64}\n$/u
        );
        expect(
          (yield* readCallers(unended)).map(({ name }) => name)
        ).toStrictEqual(["laptop", "orbs"]);
        expect(
          callerInConstantTime(
            yield* readCallers(unended),
            Redacted.value(first)
          )?.name
        ).toBe("laptop");
      })
  );

  it.effect(
    "token add refuses a name the file already holds, or one a callers file can't, and changes nothing",
    () =>
      Effect.gen(function* () {
        const file = path.join(yield* scratch, "callers");

        yield* addCaller(file, "laptop");

        const before = yield* read(file);
        const twice = yield* Effect.flip(addCaller(file, "laptop"));
        const spaced = yield* Effect.flip(addCaller(file, "my laptop"));

        expect(twice.message).toContain("already names laptop");
        expect(spaced.message).toContain("the name my laptop isn't");
        expect(yield* read(file)).toBe(before);
      })
  );
});

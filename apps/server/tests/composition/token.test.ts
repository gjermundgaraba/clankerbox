import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  callerInConstantTime,
  readCallers,
} from "@gjermundgaraba/clankerbox-sdk/node";
import {
  exists,
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Effect, Redacted } from "effect";
import { expect } from "vite-plus/test";

import {
  addCaller,
  addToken,
  listTokensOffline,
  revokeTokenOffline,
} from "../../src/composition/token.ts";
import { clientOf, plane } from "../support.ts";

const serverConfig = (stateDir: string) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const file = path.join(dir, "server.json");

    yield* write(path.join(dir, "id.pub"), `${operatorKey}\n`);
    yield* write(
      file,
      JSON.stringify({
        listen: { address: "127.0.0.1", port: 8585 },
        stateDir,
        authorizedKeys: "id.pub",
        tokens: true,
        hosts: [],
      })
    );

    return file;
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
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
  it.effect("token adds run at once each keep their line", () =>
    Effect.gen(function* () {
      const file = path.join(yield* scratch, "callers");
      const names = Array.from({ length: 8 }, (_, index) => `laptop-${index}`);

      yield* addCaller(file, "first");

      const tokens = yield* Effect.forEach(
        names,
        (name) => addCaller(file, name),
        {
          concurrency: "unbounded",
        }
      );

      const callers = yield* readCallers(file);

      expect(callers.map(({ name }) => name).toSorted()).toStrictEqual(
        ["first", ...names].toSorted()
      );
      expect(
        tokens.map(
          (token) => callerInConstantTime(callers, Redacted.value(token))?.name
        )
      ).toStrictEqual(names);
    })
  );

  it.effect(
    "token add --config mints, into a stopped control plane's store, a token the control plane then takes, and through which it lists tokens",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane({ tokens: true });

        const token = yield* addToken(
          yield* serverConfig(planned.stateDir),
          "root"
        );

        const served = yield* planned.start();

        yield* Effect.addFinalizer(() => served.crash);

        const listed = yield* (yield* clientOf(served.url, { token })).tokens;

        expect(
          listed.map(({ name, mintedBy }) => [name, mintedBy])
        ).toStrictEqual([["root", undefined]]);
      })
  );

  it.effect(
    "token add --config refuses while the control plane runs, saying to stop it or mint through a token, and adds nothing",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane({ tokens: true });
        const served = yield* planned.start();

        yield* Effect.addFinalizer(() => served.crash);

        const refused = yield* Effect.flip(
          addToken(yield* serverConfig(planned.stateDir), "root")
        );

        expect(refused.message).toContain(
          "another control plane process holds state dir"
        );
        expect(refused.message).toContain("clankerbox token");
        expect(yield* served.store.tokens).toStrictEqual([]);
      })
  );

  it.effect(
    "token list and revoke --config read and revoke a stopped control plane's tokens, what a revoked token minted included, and the control plane refuses the revoked ones once it starts",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane({ tokens: true });
        const file = yield* serverConfig(planned.stateDir);
        const root = yield* addToken(file, "root");
        const first = yield* planned.start();

        const leaked = yield* (yield* clientOf(first.url, {
          token: root,
        })).mintToken({ name: "leaked" });

        yield* (yield* clientOf(first.url, {
          token: Redacted.make(leaked.token),
        })).mintToken({ name: "planted" });
        yield* first.crash;

        expect(
          (yield* listTokensOffline(file)).map(({ name, mintedBy }) => [
            name,
            mintedBy,
          ])
        ).toStrictEqual([
          ["root", undefined],
          ["leaked", "root"],
          ["planted", "leaked"],
        ]);

        yield* revokeTokenOffline(file, "leaked");
        yield* revokeTokenOffline(file, "planted");

        expect(
          (yield* listTokensOffline(file)).map(({ name, revokedAt }) => [
            name,
            revokedAt !== undefined,
          ])
        ).toStrictEqual([
          ["root", false],
          ["leaked", true],
          ["planted", true],
        ]);

        const fresh = yield* addToken(file, "root-2");
        const second = yield* planned.start(Number(new URL(first.url).port));

        yield* Effect.addFinalizer(() => second.crash);

        const refused = yield* Effect.flip(
          (yield* clientOf(second.url, {
            token: Redacted.make(leaked.token),
          })).listMachines()
        );

        expect(refused.message).toContain("refused this caller");
        expect(
          (yield* (yield* clientOf(second.url, { token: fresh })).tokens).map(
            ({ name, revokedAt }) => [name, revokedAt !== undefined]
          )
        ).toStrictEqual([
          ["root", false],
          ["leaked", true],
          ["planted", true],
          ["root-2", false],
        ]);
      })
  );

  it.effect(
    "token list and revoke --config refuse while the control plane runs, and revoke --config names a token it doesn't hold",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane({ tokens: true });
        const file = yield* serverConfig(planned.stateDir);

        yield* addToken(file, "root");

        const nobody = yield* Effect.flip(revokeTokenOffline(file, "nobody"));

        expect([nobody._tag, nobody.message]).toStrictEqual([
          "NotFound",
          "no token nobody",
        ]);

        const served = yield* planned.start();

        yield* Effect.addFinalizer(() => served.crash);

        for (const refused of [
          yield* Effect.flip(listTokensOffline(file)),
          yield* Effect.flip(revokeTokenOffline(file, "root")),
        ]) {
          expect(refused.message).toContain(
            "another control plane process holds state dir"
          );
        }

        expect(
          (yield* served.store.tokens).map(({ revokedAt }) => revokedAt)
        ).toStrictEqual([undefined]);
      })
  );

  it.effect(
    "token list and revoke --config refuse a config whose state dir holds no store, and make none",
    () =>
      Effect.gen(function* () {
        const stateDir = path.join(yield* scratch, "never-ran");
        const file = yield* serverConfig(stateDir);

        for (const refused of [
          yield* Effect.flip(listTokensOffline(file)),
          yield* Effect.flip(revokeTokenOffline(file, "root")),
        ]) {
          expect(refused.message).toContain("doesn't exist");
          expect(refused.message).toContain("check --config");
        }

        expect(yield* exists(stateDir)).toBe(false);
      })
  );
});

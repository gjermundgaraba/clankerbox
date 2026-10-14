import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { keyFile, sshKey } from "../../../src/platform/boat/key.ts";
import { scratch, stat } from "@gjermundgaraba/clankerbox-sdk/testing";

layer(NodeServices.layer)((it) => {
  it.effect("the host generates its ed25519 key once, private to it, and keeps it", () =>
    Effect.gen(function* () {
      const stateDir = yield* scratch;

      const first = yield* sshKey(stateDir);

      expect(first.file).toBe(keyFile(stateDir));
      expect(first.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ clankerbox-boat$/u);
      expect((yield* stat(first.file)).mode & 0o777).toBe(0o600);

      const again = yield* sshKey(stateDir);

      expect(again).toEqual(first);
    }),
  );
});

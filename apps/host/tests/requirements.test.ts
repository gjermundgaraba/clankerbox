import path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { read } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect } from "effect";
import { expect } from "vite-plus/test";

import { minimumVersion as smolvm } from "../src/platform/smolvm/smolvm.ts";
import { minimumVersion as tart } from "../src/platform/tart/tart.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

layer(NodeServices.layer)((it) => {
  it.effect(
    "README states the oldest smolvm and Tart a host starts under",
    () =>
      Effect.gen(function* () {
        const readme = yield* read(path.join(root, "README.md"));

        expect(readme).toContain(`smolvm ${smolvm} or later`);
        expect(readme).toContain(`Tart ${tart} or later`);
      })
  );
});

import path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";

import { requirements } from "../src/index.ts";
import { read } from "./files.ts";

const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ engines: Schema.Struct({ node: Schema.String }) })
  )
);

const root = fileURLToPath(new URL("../../../", import.meta.url));

layer(NodeServices.layer)((it) => {
  it.effect(
    "node's range is the engines range of the root and the CLI packages",
    () =>
      Effect.gen(function* () {
        for (const file of ["package.json", "apps/clankerbox/package.json"]) {
          const manifest = yield* decodeManifest(
            yield* read(path.join(root, file))
          );

          expect(manifest.engines.node).toBe(requirements.node.engines);
        }
      })
  );

  it.effect("README states every version and base the release requires", () =>
    Effect.gen(function* () {
      const readme = yield* read(path.join(root, "README.md"));

      expect(readme).toContain(
        `smolvm exactly ${requirements.smolvm.testedVersion}`
      );
      expect(readme).toContain(`version=${requirements.smolvm.testedVersion}`);
      expect(readme).toContain(
        `Tart ${requirements.tart.minimumVersion} or later`
      );
      expect(readme).toContain(
        `Softnet ${requirements.softnet.checkedVersion}`
      );

      for (const reference of Object.values(requirements.bases).flatMap(
        Object.values
      )) {
        expect(readme).toContain(reference);
      }
    })
  );
});

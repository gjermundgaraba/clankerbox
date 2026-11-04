import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { parseSync } from "vite-plus";
import { expect } from "vite-plus/test";

const built = path.join(import.meta.dirname, "../dist/clankerbox.mjs");

layer(NodeServices.layer)((it) => {
  it.effect("the built CLI imports only node builtins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(built);
      const { module } = parseSync(built, source);

      const imported = [
        ...module.staticImports.map((entry) => entry.moduleRequest.value),
        ...module.dynamicImports.map(({ moduleRequest }) =>
          source.slice(moduleRequest.start + 1, moduleRequest.end - 1)
        ),
      ];

      expect(imported).toContain("node:fs");
      expect(
        imported.filter((name) => !name.startsWith("node:"))
      ).toStrictEqual([]);
    })
  );
});

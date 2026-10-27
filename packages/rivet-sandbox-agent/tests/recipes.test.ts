import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import { agentPort, healthPath } from "../src/agent.ts";

const recipes = ["ubuntu", "macos"];

const recipe = async (name: string) =>
  await readFile(
    new URL(`../recipes/${name}/setup.sh`, import.meta.url),
    "utf-8"
  );

describe("recipes", () => {
  it("each recipe checks the agent's health where the provider's tunnel reaches it", async () => {
    for (const name of recipes) {
      await expect(recipe(name), name).resolves.toContain(
        `http://127.0.0.1:${agentPort}${healthPath}`
      );
    }
  });
});

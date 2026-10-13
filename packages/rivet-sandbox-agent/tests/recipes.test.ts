import { readFile } from "node:fs/promises";
import { expect, test } from "vite-plus/test";
import { agentPort, healthPath } from "../src/agent.ts";

const recipes = ["ubuntu", "macos"];

const recipe = (name: string) =>
  readFile(new URL(`../recipes/${name}/setup.sh`, import.meta.url), "utf8");

test("each recipe checks the agent's health where the provider's tunnel reaches it", async () => {
  for (const name of recipes) {
    expect(await recipe(name), name).toContain(`http://127.0.0.1:${agentPort}${healthPath}`);
  }
});

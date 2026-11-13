import { SandboxAgent } from "sandbox-agent";

import { agentFetch } from "../src/fetch.ts";
import { endsWithParent, prompted } from "./support.ts";

const [url = "", dir = ""] = process.argv.slice(2);

endsWithParent();

const sdk = await SandboxAgent.connect({
  baseUrl: url,
  fetch: agentFetch("kept"),
});

const session = await sdk.createSession({ agent: "claude" });

let prompt = "still waits";

const settled = (outcome: string) => {
  prompt = outcome;

  return outcome;
};

void session.prompt([{ type: "text", text: "hi" }]).then(
  () => settled("was answered"),
  () => settled("failed")
);

await prompted(dir);

await sdk.dispose();

const disposed = performance.now();

process.once("beforeExit", () => {
  console.log(
    `idle ${Math.round(performance.now() - disposed)} ms after sdk.dispose(), and the prompt ${prompt}`
  );
});

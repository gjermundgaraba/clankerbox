import { writeFile } from "node:fs/promises";
import path from "node:path";

import { SandboxAgent } from "sandbox-agent";

import {
  cleanUp,
  endsWithParent,
  prompted,
  reachable,
  setup,
} from "./support.ts";

const [end = "", inFlight = "reply"] = process.argv.slice(2);

endsWithParent();

const { dir, sandbox } = await setup({ machines: [reachable("kept")] });

await writeFile(path.join(dir, "hold-replies"), "");

if (inFlight !== "reply") {
  await writeFile(
    path.join(dir, inFlight === "prompt-cut" ? "cut-prompts" : "hold-prompts"),
    ""
  );
}

const sdk = await SandboxAgent.start({ sandbox, sandboxId: "clankerbox/kept" });
const session = await sdk.createSession({ agent: "claude" });

console.log(`session ${session.id} on agent claude`);

const prompt = async () =>
  await session.prompt([{ type: "text", text: "hi" }]).then(
    () => "prompt answered",
    (error: unknown) =>
      error instanceof Error
        ? `prompt failed: ${error.name}: ${error.message}`
        : `prompt failed: ${String(error)}`
  );

if (inFlight === "prompt-cut") {
  console.log(await prompt());
}

const held = inFlight === "prompt-held" ? prompt() : undefined;

if (held !== undefined) {
  await prompted(dir);
}

if (end === "provider") {
  await cleanUp();
} else {
  await (end === "pause" ? sdk.pauseSandbox() : sdk.destroySandbox());
}

console.log(`sandbox ended by ${end}`);

if (held !== undefined) {
  console.log(await held);
}

await (end === "provider" ? sdk.dispose() : cleanUp());

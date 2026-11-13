import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { run, testLimit } from "./child.ts";
import { fakeAgent } from "./fake-agent.ts";

const ended = async (
  end: "destroy" | "pause" | "provider",
  inFlight?: "prompt-cut" | "prompt-held"
) =>
  await run("session.ts", [end, ...(inFlight === undefined ? [] : [inFlight])]);

const heldPromptFailed =
  "prompt failed: AcpRpcError: Internal agent error: sandbox kept's agent: socket hang up";

describe(
  "a session's sandbox ended while the agent's reply is in flight",
  { timeout: testLimit },
  () => {
    it.each(["destroy", "pause"] as const)(
      "a %s ends clean, though the SDK ends the machine before it closes its connection",
      async (end) => {
        const { code, stdout, stderr } = await ended(end);

        expect(code).toBe(0);
        expect(stdout).toContain(`sandbox ended by ${end}`);
        expect(stderr).not.toContain("ACP write error");
      }
    );

    it("a prompt whose request is cut fails as the caller's error, and the process goes on", async () => {
      const { code, stdout, stderr } = await ended("destroy", "prompt-cut");

      expect(code).toBe(0);
      expect(stdout).toContain(heldPromptFailed);
      expect(stdout).toContain("sandbox ended by destroy");
      expect(stderr).not.toContain("ACP write error");
    });

    it.each(["destroy", "pause", "provider"] as const)(
      "a prompt still waiting when a %s ends its sandbox fails as the caller's error",
      async (end) => {
        const { code, stdout, stderr } = await ended(end, "prompt-held");

        expect(code).toBe(0);
        expect(stdout).toContain(
          `sandbox ended by ${end}\n${heldPromptFailed}`
        );
        expect(stderr).not.toContain("ACP write error");
      }
    );
  }
);

describe("an SDK disposed while a prompt waits", { timeout: testLimit }, () => {
  it("lets its process end at once, the prompt never settled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-provider-"));

    await writeFile(path.join(dir, "hold-prompts"), "");

    const server = createServer(fakeAgent(dir));

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { port } = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Finite })
    )(server.address(), { onExcessProperty: "ignore" });

    try {
      const { code, stdout } = await run("disposed.ts", [
        `http://127.0.0.1:${port}`,
        dir,
      ]);

      expect(code).toBe(0);
      expect(stdout).toMatch(
        /^idle \d+ ms after sdk\.dispose\(\), and the prompt still waits\n$/u
      );
      expect(
        Number(/idle (?<ms>\d+) ms/u.exec(stdout)?.groups?.["ms"])
      ).toBeLessThan(2000);
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

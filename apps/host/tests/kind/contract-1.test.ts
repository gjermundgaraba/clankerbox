import { describe } from "@effect/vitest";

import { runtimeContract } from "../runtime-contract.ts";
import { base, dir, fixture } from "./hosted.ts";

describe.runIf(dir !== "")("agent-sandbox, on kind", () => {
  runtimeContract({
    name: "agent-sandbox adapter's",
    image: base,
    sizes: { cpu: 1, ramMib: 512, diskGib: 1 },
    stallTimeout: 600_000,
    fixture,
    part: { index: 1, of: 3 },
  });
});

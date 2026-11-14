import { closeSync, openSync } from "node:fs";

import { endsWithParent, reachable, setup } from "./support.ts";

endsWithParent();

const { sandbox } = await setup({ machines: [reachable("kept")] });

const opened = () => {
  try {
    return openSync("/dev/null", "r");
  } catch {
    return undefined;
  }
};

const held: number[] = [];

for (let fd = opened(); fd !== undefined; fd = opened()) {
  held.push(fd);
}

const outcome = await sandbox.getUrl("kept").then(
  () => "opened",
  (error: unknown) => (error instanceof Error ? error.message : String(error))
);

for (const fd of held) {
  closeSync(fd);
}

console.log(JSON.stringify({ outcome }));

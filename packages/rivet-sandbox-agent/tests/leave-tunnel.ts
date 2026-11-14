import { healthPath } from "../src/agent.ts";
import { endsWithParent, reachable, setup } from "./support.ts";

endsWithParent();

const { dir, sandbox } = await setup({ machines: [reachable("left")] });
const url = await sandbox.getUrl("left");
const sent = await sandbox.getFetch("left");

const reply = await sent(`${url}${healthPath}`);

await reply.json();

console.log(JSON.stringify({ url, dir }));

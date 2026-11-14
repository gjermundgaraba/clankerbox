import { endsWithParent, reachable, setup } from "./support.ts";

endsWithParent();

const { dir, sandbox, calls } = await setup({ machines: [reachable("left")] });

await sandbox.getUrl("left");

const [tunnel] = await calls();

process.stdout.write(
  JSON.stringify({ dir, pid: tunnel?.pid, socket: tunnel?.socket }),
  () => {
    process.kill(process.pid, "SIGKILL");
  }
);

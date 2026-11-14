import { createServer } from "node:net";

import { endsWithParent } from "./support.ts";

const [socket = ""] = process.argv.slice(2);

endsWithParent();

createServer().listen(socket, () => {
  process.stdout.write("listening", () => {
    process.kill(process.pid, "SIGKILL");
  });
});

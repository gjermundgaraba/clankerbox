import { Effect, Scope } from "effect";

import { forwarding, freePort, open } from "../src/tunnel.ts";
import { endsWithParent } from "./support.ts";

const [program = "", directory = ""] = process.argv.slice(2);

endsWithParent();

const port = await Effect.runPromise(
  Effect.gen(function* () {
    const free = yield* freePort;
    const scope = yield* Scope.make();

    yield* Scope.provide(
      open({
        program,
        args: forwarding(free, []),
        directory,
        port: free,
        machine: "left",
      }),
      scope
    );

    return free;
  })
);

console.log(String(port));

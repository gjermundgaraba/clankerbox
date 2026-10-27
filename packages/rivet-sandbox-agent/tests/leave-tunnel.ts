import { Effect, Scope } from "effect";

import { forwarding, freePort, open } from "../src/tunnel.ts";

const [program = "", directory = ""] = process.argv.slice(2);

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
        machine: "linux_left",
      }),
      scope
    );

    return free;
  })
);

console.log(String(port));

// Opens a tunnel with the program and directory it is given, prints the tunnel's port, and
// returns without closing it: what a program that leaves its sandbox running does.
import { Effect, Scope } from "effect";
import { forwarding, freePort, open } from "../src/tunnel.ts";

const [program = "", directory = ""] = process.argv.slice(2);

const tunnel = await Effect.runPromise(
  Effect.gen(function* () {
    const port = yield* freePort;
    const scope = yield* Scope.make();

    return yield* Scope.provide(
      open({ program, args: forwarding(port, 2468), directory, port, machine: "linux_left" }),
      scope,
    );
  }),
);

// A string, which no FORCE_COLOR colours as it does a number.
console.log(String(tunnel.port));

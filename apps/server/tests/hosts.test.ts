import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Duration, Effect, Logger } from "effect";
import { expect } from "vite-plus/test";

import {
  clientOf,
  eventually,
  request,
  restartedHost,
  running,
} from "./support.ts";

layer(NodeServices.layer, { excludeTestServices: true })(
  "a host's log",
  (it) => {
    it.effect(
      "a host that stops answering logs one line, whatever the machines on it and the rechecks since, and one when it answers again",
      () =>
        Effect.gen(function* () {
          const lines: string[] = [];

          const { hosts, url } = yield* running({
            recheck: Duration.millis(20),
            logger: Logger.make(({ message }) => {
              lines.push(String(message));
            }),
          });

          const [host] = hosts;
          const client = yield* clientOf(url);

          if (host === undefined) {
            throw new Error("a plane without a host");
          }

          yield* client.create("one", request("one"));
          yield* client.create("two", request("two"));
          yield* host.dispose;
          yield* eventually(
            client.hosts,
            ([only]) => only?.state === "unreachable"
          );
          yield* Effect.sleep(Duration.millis(200));
          yield* restartedHost(host);
          yield* eventually(Effect.succeed(lines), (seen) =>
            seen.includes("host linux answers again")
          );
          yield* Effect.sleep(Duration.millis(100));

          expect(
            lines.filter((line) => line.startsWith("host "))
          ).toStrictEqual([
            expect.stringContaining("host linux: "),
            "host linux answers again",
          ]);
        })
    );
  }
);

import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Logger } from "effect";
import { expect } from "vite-plus/test";

import { make } from "../../src/platform/box.ts";

const warned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: string[] = [];

    const value = yield* effect.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message }) => {
            lines.push(`${logLevel} ${[message].flat().join(" ")}`);
          }),
        ])
      )
    );

    return { value, lines };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a Linux box's ephemeral ports are its ip_local_port_range, and Linux's default, with a warning, where that can't be read",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const tuned = path.join(dir, "tuned");
        const garbled = path.join(dir, "garbled");

        yield* write(tuned, "1024\t9999\n");
        yield* write(garbled, "32768\n");

        const read = yield* warned(make("linux", tuned));
        const missing = yield* warned(make("linux", path.join(dir, "none")));
        const unread = yield* warned(make("linux", garbled));

        expect(read.value.ephemeralPorts).toStrictEqual({
          first: 1024,
          last: 9999,
          owner: "this box's ephemeral ports, its ip_local_port_range",
        });
        expect(read.lines).toStrictEqual([]);

        for (const fallback of [missing, unread]) {
          expect(fallback.value.ephemeralPorts).toStrictEqual({
            first: 32_768,
            last: 60_999,
            owner: "Linux's default ephemeral ports",
          });
          expect(fallback.lines).toStrictEqual([
            expect.stringMatching(
              /^Warn couldn't read this box's ephemeral ports from .*, so machine ports stay out of Linux's default 32768-60999$/u
            ),
          ]);
        }
      })
  );

  it.effect(
    "a macOS box's ephemeral ports are IANA's dynamic ports, as are another OS's, and no file is read",
    () =>
      Effect.gen(function* () {
        const mac = yield* make("darwin", "/nonexistent");
        const other = yield* make("freebsd", "/nonexistent");

        expect([mac.ephemeralPorts, other.ephemeralPorts]).toStrictEqual([
          { first: 49_152, last: 65_535, owner: "macOS's ephemeral ports" },
          {
            first: 49_152,
            last: 65_535,
            owner:
              "IANA's dynamic ports, which this OS takes for its ephemeral ones",
          },
        ]);
      })
  );

  it.effect(
    "a box tells its uid and that a process which runs has not ended",
    () =>
      Effect.gen(function* () {
        const box = yield* make("linux");

        expect({
          uid: box.uid,
          ended: yield* box.ended(process.pid),
        }).toStrictEqual({ uid: process.getuid?.(), ended: false });
      })
  );
});

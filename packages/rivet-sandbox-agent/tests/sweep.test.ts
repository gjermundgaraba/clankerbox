import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  lutimes,
  mkdir,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import { sweep } from "../src/tunnel.ts";
import { run } from "./child.ts";
import { aged, cleanUp, cleanups, leftIn, past, scratch } from "./support.ts";

const uid = process.getuid?.() ?? 0;

const leftBehind = async () => {
  const under = await scratch();
  const outside = await scratch();
  const kept = path.join(outside, "kept");

  await writeFile(kept, "");

  const missing = await leftIn(under, "clankerbox-tunnel-Gone01");

  await symlink(kept, path.join(missing, "linked"));

  const stale = await leftIn(under, "clankerbox-tunnel-Stale1");
  const killed = await run("listen-on.ts", [path.join(stale, "agent.sock")]);

  const listened = await leftIn(under, "clankerbox-tunnel-Live01");
  const listener = createServer();

  listener.listen(path.join(listened, "agent.sock"));
  await once(listener, "listening");
  const barred = await leftIn(under, "clankerbox-tunnel-Barred");
  const unreachable = createServer();
  const barredSocket = path.join(barred, "agent.sock");

  unreachable.listen(barredSocket);
  await once(unreachable, "listening");
  await chmod(barredSocket, 0o000);
  cleanups.push(async () => {
    listener.close();
    unreachable.close();
  });

  await mkdir(path.join(under, "clankerbox-tunnel-Young1"));

  const target = await leftIn(outside, "clankerbox-tunnel-Target");
  const linked = path.join(under, "clankerbox-tunnel-Link01");

  await symlink(target, linked);
  await lutimes(linked, past(), past());

  const named = [
    await leftIn(under, "clankerbox-tunnel-short"),
    await leftIn(under, "clankerbox-tunnel-Longer1"),
    await leftIn(under, "clankerbox-provider-Other1"),
  ];

  const file = path.join(under, "clankerbox-tunnel-File01");

  await writeFile(file, "");

  for (const made of [
    missing,
    stale,
    listened,
    barred,
    target,
    ...named,
    file,
  ]) {
    await aged(made);
  }

  return { under, kept, target, listening: killed.stdout };
};

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  afterEach(cleanUp);

  it.effect(
    "the sweep removes this user's tunnel directories older than a minute whose socket is missing or refuses a connection, and nothing else, not one whose socket it may not reach",
    () =>
      Effect.gen(function* () {
        const { under, kept, target, listening } =
          yield* Effect.promise(leftBehind);

        yield* sweep(under, uid);

        const after = yield* Effect.promise(async () => await readdir(under));

        expect(listening).toBe("listening");
        expect(after.toSorted()).toStrictEqual(
          [
            "clankerbox-provider-Other1",
            "clankerbox-tunnel-Barred",
            "clankerbox-tunnel-File01",
            "clankerbox-tunnel-Link01",
            "clankerbox-tunnel-Live01",
            "clankerbox-tunnel-Longer1",
            "clankerbox-tunnel-Young1",
            "clankerbox-tunnel-short",
          ].toSorted()
        );
        expect([existsSync(kept), existsSync(target)]).toStrictEqual([
          true,
          true,
        ]);
      })
  );

  it.effect("the sweep leaves another user's tunnel directories", () =>
    Effect.gen(function* () {
      const under = yield* Effect.promise(scratch);

      const left = yield* Effect.promise(
        async () => await leftIn(under, "clankerbox-tunnel-Other1")
      );

      yield* Effect.promise(async () => {
        await aged(left);
      });
      yield* sweep(under, uid + 1);

      expect(existsSync(left)).toBe(true);
    })
  );
});

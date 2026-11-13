import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  mkdir,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";

import * as Home from "../../../src/platform/tart/home.ts";

const layouts: ReadonlyArray<readonly [string, readonly string[] | undefined]> =
  [
    ["standalone", ["config.json", "nvram.bin", "disk.img"]],
    [
      "a pulled standalone record",
      ["config.json", "nvram.bin", "disk.img", "manifest.json"],
    ],
    [
      "stacked, local",
      ["config.json", "nvram.bin", "manifest.json", "overlay.asif"],
    ],
    ["a stacked OCI record", ["config.json", "nvram.bin", "manifest.json"]],
    [
      "disk.img beside overlay.asif",
      ["config.json", "nvram.bin", "disk.img", "manifest.json", "overlay.asif"],
    ],
    ["no nvram.bin", ["config.json", "disk.img"]],
    ["no config.json", ["nvram.bin", "disk.img"]],
    [
      "stacked, without its manifest",
      ["config.json", "nvram.bin", "overlay.asif"],
    ],
    ["config.json and nvram.bin alone", ["config.json", "nvram.bin"]],
    ["any other files", ["control.sock", "notes.txt"]],
    ["an empty directory", []],
    ["no directory", undefined],
  ];

layer(NodeServices.layer)((it) => {
  it.effect(
    "a directory is a VM only in Tart 2.41.1's two runnable layouts, and paused when it also holds state.vzvmsave",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tartHome = path.join(yield* scratch, "tart");
        const home = Home.make(fs, tartHome);

        const read: Record<string, { readonly saved: boolean } | undefined> =
          {};

        for (const [layout, entries] of layouts) {
          for (const saved of [false, true]) {
            const vm = `${layout}${saved ? ", saved" : ""}`;

            if (entries !== undefined) {
              yield* mkdir(home.directory(vm));

              for (const entry of saved
                ? [...entries, "state.vzvmsave"]
                : entries) {
                yield* write(path.join(home.directory(vm), entry), "");
              }
            }

            read[vm] = yield* home.look(vm);
          }
        }

        expect(read).toStrictEqual({
          standalone: { saved: false },
          "standalone, saved": { saved: true },
          "a pulled standalone record": { saved: false },
          "a pulled standalone record, saved": { saved: true },
          "stacked, local": { saved: false },
          "stacked, local, saved": { saved: true },
          "a stacked OCI record": undefined,
          "a stacked OCI record, saved": undefined,
          "disk.img beside overlay.asif": undefined,
          "disk.img beside overlay.asif, saved": undefined,
          "no nvram.bin": undefined,
          "no nvram.bin, saved": undefined,
          "no config.json": undefined,
          "no config.json, saved": undefined,
          "stacked, without its manifest": undefined,
          "stacked, without its manifest, saved": undefined,
          "config.json and nvram.bin alone": undefined,
          "config.json and nvram.bin alone, saved": undefined,
          "any other files": undefined,
          "any other files, saved": undefined,
          "an empty directory": undefined,
          "an empty directory, saved": undefined,
          "no directory": undefined,
          "no directory, saved": undefined,
        });
      })
  );
});

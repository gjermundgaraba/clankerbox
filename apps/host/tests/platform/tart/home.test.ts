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
    "a directory is a VM only in Tart 2.41.1's two runnable layouts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tartHome = path.join(yield* scratch, "tart");
        const home = Home.make(fs, tartHome);

        const read: Record<string, boolean> = {};

        for (const [layout, entries] of layouts) {
          if (entries !== undefined) {
            yield* mkdir(home.directory(layout));

            for (const entry of entries) {
              yield* write(path.join(home.directory(layout), entry), "");
            }
          }

          read[layout] = yield* home.look(layout);
        }

        expect(read).toStrictEqual({
          standalone: true,
          "a pulled standalone record": true,
          "stacked, local": true,
          "a stacked OCI record": false,
          "disk.img beside overlay.asif": false,
          "no nvram.bin": false,
          "no config.json": false,
          "stacked, without its manifest": false,
          "config.json and nvram.bin alone": false,
          "any other files": false,
          "an empty directory": false,
          "no directory": false,
        });
      })
  );
});

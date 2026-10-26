import type { Kind } from "./resources.ts";

const bases = {
  linux: {
    ubuntu:
      "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7",
  },
  mac: {
    macos:
      "ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:71d9dc1d6c4614b7ecbb328753124912b43425fc8cf1c4085d7f352026df6601",
  },
} as const satisfies Record<Kind, Readonly<Record<string, string>>>;

/**
 * What a host of this release runs on, as clankerbox checked it. `smolvm` is the one release a
 * linux host starts under, and `tart` the oldest a mac host starts under; `softnet` is the release
 * the mac host was checked against, which nothing enforces. `node` is the CLI's `engines` range.
 * `bases` are, per kind, the bases a host config names, pinned by digest: the images the host's
 * claims about its guests were checked on. The `bump-smolvm` and `bump-tart` skills own them.
 */
export const requirements = {
  smolvm: { testedVersion: "1.32.1" },
  tart: { minimumVersion: "2.41.1" },
  softnet: { checkedVersion: "0.24.1" },
  node: { engines: ">=26.12.0" },
  bases,
} as const;

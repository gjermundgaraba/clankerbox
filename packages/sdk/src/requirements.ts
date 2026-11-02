import type { Kind } from "./resources.ts";

const bases = {
  linux: {
    ubuntu:
      "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7",
  },
  mac: {
    macos:
      "ghcr.io/cirruslabs/macos-golden-gate-xcode@sha256:d7641b1d985fd53fbac071c663bf249007b9b387e16b7d576144588acb1d93f9",
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
  smolvm: { testedVersion: "1.33.0" },
  tart: { minimumVersion: "2.41.1" },
  softnet: { checkedVersion: "0.25.0" },
  node: { engines: ">=26.12.0" },
  bases,
} as const;

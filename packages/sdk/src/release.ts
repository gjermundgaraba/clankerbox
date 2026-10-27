import packageJson from "../package.json" with { type: "json" };

/** Also the version of the clankerbox CLI released with it. */
export const version: string = packageJson.version;

/** major.minor: releases that share it speak the same API. */
export const release = (of: string): string =>
  of.split(".").slice(0, 2).join(".");

/** A host refuses a request whose `release` differs from its own, or that has none. */
export const versionHeader = "clankerbox-version";

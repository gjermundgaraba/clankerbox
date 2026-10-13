/** Which clankerbox release this is, and how a client and a host tell whether they match. */
import packageJson from "../package.json" with { type: "json" };

/** The SDK's version, which is also the version of the clankerbox binaries it ships with. */
export const version: string = packageJson.version;

/** A version's major.minor: releases that share it speak the same API. */
export const release = (of: string): string => of.split(".").slice(0, 2).join(".");

/**
 * The header every client request carries the SDK's `version` in. A host refuses a request
 * whose release (major.minor) differs from its own, or that carries none, before it runs
 * anything.
 */
export const versionHeader = "clankerbox-version";

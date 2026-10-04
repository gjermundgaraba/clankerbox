import packageJson from "../package.json" with { type: "json" };

/** The SDK's version, which is also the version of the clankerbox binaries it ships with. */
export const version: string = packageJson.version;

export * from "./api.ts";

export * from "./errors.ts";

export * from "./ids.ts";

export * from "./resources.ts";

export * as Client from "./client.ts";

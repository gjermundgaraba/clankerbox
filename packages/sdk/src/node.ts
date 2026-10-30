import { BlockList, isIP } from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer, Schema } from "effect";

import * as Client from "./client.ts";
import type { Invalid } from "./errors.ts";

/**
 * The client over Node's `http`. It is in `./node`, apart from `.`, so an app that brings its own
 * `HttpClient` never loads `@effect/platform-node`.
 */
export const layer = (
  url: string,
  options?: Client.Options
): Layer.Layer<Client.Client, Invalid> =>
  Client.layer(url, options).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

const reachable = new BlockList();

// https://tailscale.com/docs/concepts/tailscale-ip-addresses
// https://tailscale.com/docs/concepts/ip-and-dns-addresses
const subnets = [
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["fd7a:115c:a1e0::", 48, "ipv6"],
  ["::1", 128, "ipv6"],
] as const;

for (const [network, prefix, family] of subnets) {
  reachable.addSubnet(network, prefix, family);
}

const addressRule =
  "a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a loopback address";

/** What a server may listen on: never where a guest or the internet reaches it. */
export const Address = Schema.String.check(
  Schema.makeFilter((address: string) => {
    const family = isIP(address);

    return (
      (family !== 0 &&
        reachable.check(address, family === 4 ? "ipv4" : "ipv6")) ||
      addressRule
    );
  })
);

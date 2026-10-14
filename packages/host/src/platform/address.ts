import { BlockList, isIP } from "node:net";
import { Schema } from "effect";

const reachable = new BlockList();

// Source: tailscale.com/kb/1015, tailscale.com/kb/1033
const subnets = [
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["fd7a:115c:a1e0::", 48, "ipv6"],
  ["::1", 128, "ipv6"],
] as const;

for (const [network, prefix, family] of subnets) {
  reachable.addSubnet(network, prefix, family);
}

const addressRule = "a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a loopback address";

export const Address = Schema.String.check(
  Schema.makeFilter((address: string) => {
    const family = isIP(address);

    return (
      (family !== 0 && reachable.check(address, family === 4 ? "ipv4" : "ipv6")) || addressRule
    );
  }),
);

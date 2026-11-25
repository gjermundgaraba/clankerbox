import { once } from "node:events";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";

import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { closingServer } from "../src/node.ts";
import { testTls } from "./tls.ts";

const portOf = (address: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(address, {
    onExcessProperty: "ignore",
  }).port;

describe("closingServer over TLS", () => {
  it("closes within a second while one connection has finished its handshake and another never began it", async () => {
    const server = closingServer(testTls);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const port = portOf(server.address());
    const secure = connectTls({ host: "127.0.0.1", port, ca: testTls.cert });

    await once(secure, "secureConnect");

    const silent = connect(port, "127.0.0.1");

    await once(silent, "connect");

    const closed = once(server, "close", { signal: AbortSignal.timeout(1000) });

    server.close();

    await expect(closed).resolves.toStrictEqual([]);
    expect(secure.authorized).toBe(true);

    secure.destroy();
    silent.destroy();
  });
});

/**
 * Apart from `.`, so an app that brings its own `HttpClient` never loads
 * `@effect/platform-node`.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer } from "effect";
import * as Client from "./client.ts";
import type { Invalid } from "./errors.ts";

/** Over Node's `http`, which sets no timeout of its own: a mutation can run for hours. */
export const layer = (
  hosts: ReadonlyArray<Client.HostEntry>,
  options?: Client.Options,
): Layer.Layer<Client.Client, Invalid> =>
  Client.layer(hosts, options).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

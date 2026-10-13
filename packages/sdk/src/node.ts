/**
 * The client over Node's `http` module, the SDK's `/node` entry. It stands apart so that an
 * app that brings its own `HttpClient` to `Client.layer` never loads `@effect/platform-node`.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer } from "effect";
import * as Client from "./client/client.ts";
import type { Invalid } from "./errors.ts";

/** Node's `http` module sets no timeout of its own: a mutation can run for hours. */
export const layer = (
  hosts: ReadonlyArray<Client.HostEntry>,
  options?: Client.Options,
): Layer.Layer<Client.Client, Invalid> =>
  Client.layer(hosts, options).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

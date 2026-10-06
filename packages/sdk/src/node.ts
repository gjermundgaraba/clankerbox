/**
 * The client over Node's `http` module, the SDK's `/node` entry. It stands apart so that an
 * app that brings its own `HttpClient` to `Client.make` never loads `@effect/platform-node`.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer } from "effect";
import { Client, type HostEntry, make, type Options } from "./client.ts";
import type { Invalid } from "./errors.ts";

/** Node's `http` module sets no timeout of its own: a mutation can run for hours. */
export const layer = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Layer.Layer<Client, Invalid> =>
  Layer.effect(Client, make(hosts, options)).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

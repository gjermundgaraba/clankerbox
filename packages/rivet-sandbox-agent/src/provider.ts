import { ManagedRuntime } from "effect";
import type { Layer } from "effect";

import type { ClankerboxProvider, Options } from "./options.ts";
import { defaultCwd, make, name } from "./sandboxes.ts";
import type { Services } from "./sandboxes.ts";

export const provider = <E>(
  options: Options,
  layer: Layer.Layer<Services, E>,
  ssh?: string
): ClankerboxProvider => {
  const runtime = ManagedRuntime.make(layer);
  const sandboxes = make(options, ssh);

  return {
    name,
    defaultCwd: options.cwd ?? defaultCwd,
    create: async () => await runtime.runPromise(sandboxes.create),
    destroy: async (id) => {
      await runtime.runPromise(sandboxes.destroy(id));
    },
    pause: async (id) => {
      await runtime.runPromise(sandboxes.pause(id));
    },
    resize: async (id, sizes) =>
      await runtime.runPromise(sandboxes.resize(id, sizes)),
    reconnect: async (id) => {
      await runtime.runPromise(sandboxes.reconnect(id));
    },
    ensureServer: async (id) => {
      await runtime.runPromise(sandboxes.ensureServer(id));
    },
    getUrl: async (id) => await runtime.runPromise(sandboxes.url(id)),
    dispose: async () => {
      await runtime.runPromise(sandboxes.closeAll);
      await runtime.dispose();
    },
  };
};

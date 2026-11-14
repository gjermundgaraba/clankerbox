import { ManagedRuntime } from "effect";
import type { Effect, Layer } from "effect";

import type { ClankerboxProvider, Options } from "./options.ts";
import { defaultCwd, disposed, make, name } from "./sandboxes.ts";
import type { Services } from "./sandboxes.ts";

export const provider = <E>(
  options: Options,
  layer: Layer.Layer<Services, E>,
  ssh?: string
): ClankerboxProvider => {
  const runtime = ManagedRuntime.make(layer);
  const sandboxes = make(options, ssh);
  let disposal: Promise<void> | undefined;

  const run = async <A, F>(effect: Effect.Effect<A, F, Services>) => {
    if (disposal !== undefined) {
      throw disposed();
    }

    return await runtime.runPromise(effect);
  };

  return {
    name,
    defaultCwd: options.cwd ?? defaultCwd,
    create: async () => await run(sandboxes.create),
    destroy: async (id) => {
      await run(sandboxes.destroy(id));
    },
    pause: async (id) => {
      await run(sandboxes.pause(id));
    },
    resize: async (id, sizes) => await run(sandboxes.resize(id, sizes)),
    reconnect: async (id) => {
      await run(sandboxes.reconnect(id));
    },
    ensureServer: async (id) => {
      await run(sandboxes.ensureServer(id));
    },
    getUrl: async (id) => await run(sandboxes.url(id)),
    getFetch: async (id) => await run(sandboxes.fetch(id)),
    dispose: async () => {
      disposal ??= (async () => {
        try {
          await runtime.runPromise(sandboxes.closeAll);
        } finally {
          await runtime.dispose();
        }
      })();

      await disposal;
    },
  };
};

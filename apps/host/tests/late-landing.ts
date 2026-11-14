import { Effect } from "effect";

interface Armed {
  released: boolean;
  land: (() => unknown) | undefined;
}

/**
 * The makes a fake fails whose machines land all the same, each when the test releases it: `arm`
 * answers the release, and `next` the hold of the next make armed, which lands that make's machine
 * at once if the test released it first.
 */
export const lateLandings = () => {
  const armed: Armed[] = [];

  return {
    arm: Effect.sync(() => {
      const late: Armed = { released: false, land: undefined };

      armed.push(late);

      return Effect.promise(async () => {
        const { land } = late;

        late.released = true;
        late.land = undefined;
        await land?.();
      });
    }),
    next: (): ((land: () => unknown) => Promise<void>) | undefined => {
      const late = armed.shift();

      return late === undefined
        ? undefined
        : async (land) => {
            if (late.released) {
              await land();
            } else {
              late.land = land;
            }
          };
    },
  };
};

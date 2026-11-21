import { Effect } from "effect";

interface Armed {
  released: boolean;
  land: (() => unknown) | undefined;
}

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

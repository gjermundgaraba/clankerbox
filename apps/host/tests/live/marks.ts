/** The live suite's mark. Its host part starts with a digit, which no host ID can, so no real host's machine carries it. */
export const liveMark = "cbx-0live-";

/** The host ID the live suite runs its host under, which no host ID can equal or start, so its machines carry `liveMark`. */
export const liveHostId = (run: string) => `0live-${run}`;

export const liveRun = (run: string | undefined): boolean =>
  run !== undefined && /^0live-[0-9a-f]+$/u.test(run);

export const runOfLabel = (host: string | undefined): string | undefined =>
  liveRun(host) ? host : undefined;

export const runOfName = (
  name: string | null | undefined
): string | undefined =>
  /^cbx-(?<run>0live-[0-9a-f]+)-/u.exec(name ?? "")?.groups?.["run"];

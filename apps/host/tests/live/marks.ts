export const liveMark = "cbx-0live-";

export const liveHostId = (run: string) => `0live-${run}`;

export const liveRun = (run: string | undefined): boolean =>
  run !== undefined && /^0live-[0-9a-f]+$/u.test(run);

export const runOfLabel = (host: string | undefined): string | undefined =>
  liveRun(host) ? host : undefined;

export const runOfName = (
  name: string | null | undefined
): string | undefined =>
  /^cbx-(?<run>0live-[0-9a-f]+)-/u.exec(name ?? "")?.groups?.["run"];

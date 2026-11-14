import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Predicate } from "effect";

import { slotSize, slotsFrom, slotsTo, testPortsVariable } from "./support.ts";

const claims = path.join(tmpdir(), "clankerbox-host-test-ports");

const claimed = (file: string): number | undefined => {
  const pid = Number(readFileSync(file, "utf8"));

  return Number.isInteger(pid) ? pid : undefined;
};

const alive = (pid: number | undefined) => {
  if (pid === undefined) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
};

const claim = (file: string) => {
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });

    return true;
  } catch {
    if (alive(claimed(file))) {
      return false;
    }

    rmSync(file, { force: true });

    return claim(file);
  }
};

/**
 * Claims a slot of the host's test ports for this run, so no other run on the machine, of another
 * checkout or another suite, takes the same ones while it lasts.
 */
export default function setup() {
  mkdirSync(claims, { recursive: true });

  for (let first = slotsFrom; first + slotSize <= slotsTo; first += slotSize) {
    const file = path.join(claims, `${first}.pid`);

    if (claim(file)) {
      process.env[testPortsVariable] = String(first);

      return () => {
        rmSync(file, { force: true });
      };
    }
  }

  throw new Error(
    `every slot of the host's test ports in ${claims} is claimed by a live run`
  );
}

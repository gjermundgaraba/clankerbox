import { once } from "node:events";
import { createServer } from "node:net";
import type { Server } from "node:net";

import type { PortRange } from "../src/machine-ports.ts";

/** The variable the global setup sets to the first port of the slot it claims for the run. */
export const testPortsVariable = "CLANKERBOX_TEST_PORTS";

export const slotsFrom = 22_000;

export const slotsTo = 32_000;

export const slotSize = 250;

/**
 * The port of a slot a run listens on while it holds the slot. The kernel lets one process listen
 * on a port and frees it the moment that process ends, so a claim is never stale and two runs never
 * hold one slot.
 */
export const claimOffset = slotSize - 1;

/** How many ports each host of a test control plane takes, `planes` cut into ranges this size. */
export const planeRange = 20;

/** How many ports each rented host of a test takes, `rented` cut into ranges this size. */
export const rentedRange = 11;

const slotFirst = () => {
  const first = Number(process.env[testPortsVariable]);

  if (!Number.isInteger(first) || first < slotsFrom) {
    throw new Error(
      `no slot of test ports is claimed: ${testPortsVariable} is unset, as only a test run's global setup, apps/host/tests/port-slot.ts, sets it`
    );
  }

  return first;
};

const inSlot = (offset: number, size = 10): PortRange => ({
  first: slotFirst() + offset,
  last: slotFirst() + offset + size - 1,
});

/**
 * Every port range a test of any package listens on. `shared` sits outside the slots: the hosts
 * that take it, and a host the verify skill serves, probe each port before they take it. Every other
 * range lies within the slot the run claimed, at a fixed offset, so no other run on the machine
 * holds it while this one lasts; each is read only once the slot is claimed.
 */
export const suitePorts = {
  shared: { first: 21_000, last: 21_099 },
  get tailnet() {
    return inSlot(0);
  },
  get routes() {
    return inSlot(10);
  },
  get host() {
    return inSlot(20);
  },
  get smolCloud() {
    return inSlot(30);
  },
  get operations() {
    return inSlot(40);
  },
  get tart() {
    return inSlot(50);
  },
  get liveSmolCloud() {
    return inSlot(60);
  },
  get journal() {
    return inSlot(70);
  },
  get serverMachines() {
    return inSlot(80);
  },
  get reach() {
    return inSlot(90);
  },
  get planes() {
    return inSlot(100, 4 * planeRange);
  },
  get rented() {
    return inSlot(180, 4 * rentedRange);
  },
} as const satisfies Readonly<Record<string, PortRange>>;

const listening = async (port: number): Promise<Server | undefined> => {
  const server = createServer((socket) => {
    socket.destroy();
  });

  server.listen({ host: "127.0.0.1", port, exclusive: true });

  try {
    await once(server, "listening");

    return server;
  } catch {
    return undefined;
  }
};

const closed = async (server: Server) => {
  server.close();
  await once(server, "close");
};

const slotUnheld = async (first: number) => {
  for (let port = first; port < first + claimOffset; port += 1) {
    const probe = await listening(port);

    if (probe === undefined) {
      return false;
    }

    await closed(probe);
  }

  return true;
};

/**
 * Claims the first slot no other process holds, and on none of whose ports another listens, by
 * listening on its claim port until `release`.
 */
export const claimSlot = async () => {
  for (let first = slotsFrom; first + slotSize <= slotsTo; first += slotSize) {
    const claim = await listening(first + claimOffset);

    if (claim !== undefined && !(await slotUnheld(first))) {
      await closed(claim);
    } else if (claim !== undefined) {
      return {
        first,
        release: async () => {
          claim.close();
          await once(claim, "close");
        },
      };
    }
  }

  throw new Error(
    `every slot of test ports from ${slotsFrom} to ${slotsTo} is claimed: a process listens on each one's port ${claimOffset} past its first`
  );
};

/** The global setup of each package whose tests listen: claims a slot for the run. */
export default async function setup() {
  const { first, release } = await claimSlot();

  process.env[testPortsVariable] = String(first);

  return release;
}

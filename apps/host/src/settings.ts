import { Schema } from "effect";

import type { PortRange } from "./machine-ports.ts";

export interface HostSettings {
  readonly id: string;
  readonly listen: { readonly address: string; readonly port: number };
  readonly stateDir: string;
  readonly bases: ReadonlyMap<string, string>;
  readonly machinePorts: PortRange;
}

const loopback = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/u;

/** A provider's API URL, which its key rides on with every request: `https`, or `http` only to a loopback address. */
export const KeyedApiUrl = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const url = URL.parse(text);

    return (
      url?.protocol === "https:" ||
      (url?.protocol === "http:" && loopback.test(url.hostname)) ||
      "an https URL, or an http one to a loopback address, as the key rides on every request"
    );
  })
);

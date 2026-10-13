/** The Sandbox Agent's server in the guest, as the recipes beside this package run it. */

/** The port it listens on, on the guest's loopback: its default, which the recipes keep. */
export const agentPort = 2468;

/** Where it answers its health check. */
export const healthPath = "/v1/health";

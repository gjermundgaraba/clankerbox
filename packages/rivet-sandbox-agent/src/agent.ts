/** The Sandbox Agent's default port, which the recipes keep, on the guest's loopback. */
export const agentPort = 2468;

export const healthPath = "/v1/health";

/** Where the server lists its ACP servers, and where `DELETE /v1/acp/<serverId>` closes one. */
export const acpPath = "/v1/acp";

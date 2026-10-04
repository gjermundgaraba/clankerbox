import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Console, type Effect } from "effect";

/** The host role. It only says hello until it serves the API. */
export const runHost: Effect.Effect<void> = Console.log(`clankerbox host ${version}`);

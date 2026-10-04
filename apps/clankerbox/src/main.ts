import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { main } from "./roles.ts";

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);

import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Effect, Layer } from "effect";

import { make as smolvm } from "../src/platform/smolvm/smolvm.ts";
import { make as tart } from "../src/platform/tart/tart.ts";
import { Runtime } from "../src/runtime.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import type { FakeRuntimeName, Preset } from "./fake-runtime.ts";
import { runtimeContract } from "./runtime-contract.ts";
import { scriptedMac } from "./scripted-mac.ts";
import { prepared, smolvmModel } from "./smolvm-model.ts";
import { image } from "./support.ts";

const onFake = (as: FakeRuntimeName, owned?: Preset["owned"]) => {
  runtimeContract({
    name: `fake ${as}${owned === undefined ? "" : ` with ${owned.checkpoints} checkpoints`}`,
    image,
    sizes: { cpu: 1, ramMib: 1024, diskGib: 10 },
    fixture: Effect.gen(function* () {
      const dir = yield* scratch;
      const fake = fakeRuntime({ dir, as, owned });

      const context = yield* Layer.build(
        Layer.provide(fake.layer, NodeServices.layer)
      );

      return {
        runtime: Context.get(context, Runtime),
        faults: fake.faults,
        unmarked: fake.unmarked,
      };
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
  });
};

onFake("smolvm");

onFake("tart");

onFake("fixed");

onFake("fixed", { checkpoints: "marked" });

runtimeContract({
  name: "smolvm adapter's",
  image: "registry.example/ubuntu@sha256:00",
  sizes: { cpu: 2, ramMib: 2048, diskGib: 20 },
  fixture: Effect.gen(function* () {
    const model = smolvmModel();

    const runtime = yield* smolvm(yield* prepared(), 0).pipe(
      Effect.provide(model.spawner.layer)
    );

    return { runtime, faults: undefined, unmarked: undefined };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
});

runtimeContract({
  name: "Tart adapter's",
  image: "ghcr.io/cirruslabs/macos-sequoia-base:latest",
  sizes: { cpu: 4, ramMib: 8192, diskGib: 60 },
  fixture: Effect.gen(function* () {
    const mac = scriptedMac(path.join(yield* scratch, "state"));

    const runtime = yield* tart(mac.settings).pipe(
      Effect.provide(mac.spawner.layer)
    );

    yield* runtime.startup;

    return { runtime, faults: undefined, unmarked: undefined };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
});

import { writeFileSync } from "node:fs";
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
import type { Faults } from "./runtime-contract.ts";
import { scriptedMac } from "./scripted-mac.ts";
import { prepared, smolvmModel } from "./smolvm-model.ts";
import { image } from "./support.ts";

const onFake = (as: FakeRuntimeName, owned?: Preset["owned"]) => {
  runtimeContract({
    name: `fake ${as}${owned === undefined ? "" : ` with ${owned.checkpoints} checkpoints`}`,
    image,
    sizes: { cpu: 1, ramMib: 1024, diskGib: 10 },
    lacks: {
      stall:
        "the fake runtime is no adapter: it answers each call in memory, with no provider call to hold",
    },
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
  runsNoGuest:
    "its model answers the commands smolvm takes, and runs none of a guest's",
  lacks: {
    dropAnswer:
      "smolvm is a CLI on this host, whose answer is its exit status, which no connection can lose",
    landLate:
      "a smolvm call makes the machine before it answers, so no make lands after its answer",
    quota:
      "smolvm keeps no quota: the host's RAM budget refuses a make before smolvm runs, as the admission tests hold",
  },
  image: "registry.example/ubuntu@sha256:00",
  sizes: { cpu: 2, ramMib: 2048, diskGib: 20 },
  fixture: Effect.gen(function* () {
    const model = smolvmModel();

    const runtime = yield* smolvm(yield* prepared(), model.box()).pipe(
      Effect.provide(model.spawner.layer)
    );

    const faults: Partial<Faults> = {
      drift: (instance) =>
        Effect.sync(() => {
          const vm = [...model.vms].find(([name]) =>
            name.endsWith(`-${instance.slice(0, 8)}`)
          )?.[1];

          if (vm !== undefined) {
            vm.state = "stopped";
          }
        }),
      stall: model.spawner.stall,
    };

    return { runtime, faults, unmarked: undefined };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
});

runtimeContract({
  name: "Tart adapter's",
  runsNoGuest:
    "its scripted Mac answers the commands Tart takes, and runs none of a guest's",
  lacks: {
    dropAnswer:
      "tart is a CLI on this host, whose answer is its exit status, which no connection can lose",
    landLate:
      "a tart call makes the VM before it answers, so no make lands after its answer",
  },
  image: "ghcr.io/cirruslabs/macos-sequoia-base:latest",
  sizes: { cpu: 4, ramMib: 8192, diskGib: 60 },
  fixture: Effect.gen(function* () {
    const mac = scriptedMac(path.join(yield* scratch, "state"));

    const runtime = yield* tart(mac.settings).pipe(
      Effect.provide(mac.spawner.layer)
    );

    yield* runtime.startup;

    let refusing = false;

    mac.hooks.kickstart = (vm) => {
      if (refusing) {
        mac.exited.set(vm, 1);
        writeFileSync(
          mac.logOf(vm),
          "The number of VMs exceeds the system limit (other running VMs: a1, a2)\n"
        );
      } else {
        mac.startVm(vm);
      }
    };

    const faults: Partial<Faults> = {
      drift: (instance) =>
        Effect.sync(() => {
          for (const vm of mac.vms.keys()) {
            if (vm.endsWith(`-${instance.slice(0, 8)}`)) {
              mac.vms.set(vm, "stopped");
            }
          }
        }),
      quota: (on) =>
        Effect.sync(() => {
          refusing = on;
        }),
      stall: mac.spawner.stall,
    };

    return { runtime, faults, unmarked: undefined };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
});

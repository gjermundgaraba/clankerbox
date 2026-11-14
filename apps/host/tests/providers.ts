import path from "node:path";

import { Effect, Layer } from "effect";
import type { Duration } from "effect";

import * as Boat from "../src/platform/boat/boat.ts";
import * as SmolCloud from "../src/platform/smol-cloud/smol-cloud.ts";
import { fakeBoat, fakeBoatSsh, traits as boatTraits } from "./fake-boat.ts";
import type { FakeBoat } from "./fake-boat.ts";
import { fakeSmolCloud, traits as smolCloudTraits } from "./fake-smol-cloud.ts";
import type { FakeSmolCloud } from "./fake-smol-cloud.ts";
import { fakeTailnet } from "./serving.ts";
import type { Provider } from "./serving.ts";
import { image, writeTailscaleStubs } from "./support.ts";

const smolCloudKey = "fake-smol-cloud-key";

/** smol cloud, `guestPath` an exec's `PATH` after its fake's own stubs, the runner's own unless given. */
export const smolCloud = (guestPath?: string): Provider<FakeSmolCloud> => ({
  name: "smol-cloud",
  image,
  traits: smolCloudTraits,
  fake: (dir, record) =>
    Effect.map(
      fakeSmolCloud({
        dir,
        key: smolCloudKey,
        onCall: record?.call,
        guestPath,
      }),
      (fake) => {
        if (fakeTailnet) {
          writeTailscaleStubs(path.join(dir, "bin"));
        }

        return {
          fake,
          url: fake.url,
          key: smolCloudKey,
          faults: fake.faults,
          holdCapture: fake.holdCapture,
          drift: {
            _tag: "never",
            because:
              "a smol cloud machine's name holds its instance, which a host isn't told by the machine's name",
          },
        };
      }
    ),
  layer: (api, host) =>
    SmolCloud.layer({ apiKeyFile: api.keyFile, api: api.url }, host),
});

export const boat = (
  keepsStoppedFor?: Duration.Duration
): Provider<FakeBoat> => ({
  name: "boat",
  image: Boat.image,
  traits: boatTraits,
  fake: (dir, record) =>
    Effect.map(
      fakeBoat({
        dir,
        keepsStoppedFor,
        onCall:
          record === undefined
            ? undefined
            : (line, request) => {
                record.call(line);
                record.request(request);
              },
      }),
      (fake) => ({
        fake,
        url: fake.url,
        key: fake.apiKey,
        faults: fake.faults,
        holdCapture: undefined,
        drift: {
          _tag: "by-name",
          running: (machine) =>
            [...fake.sandboxes.values()].find(
              ({ name, running }) => name === machine && running
            )?.labels[Boat.instanceLabel],
        },
      })
    ),
  layer: (api, host) =>
    Boat.layer({ apiKeyFile: api.keyFile, api: api.url }, host).pipe(
      Layer.provide(fakeBoatSsh(api.url, api.key))
    ),
});

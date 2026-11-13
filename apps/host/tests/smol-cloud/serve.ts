import path from "node:path";

import { Effect } from "effect";

import * as SmolCloud from "../../src/platform/smol-cloud/smol-cloud.ts";
import { fakeSmolCloud } from "../fake-smol-cloud.ts";
import { fakeTailnet, serveProvider } from "../serving.ts";
import { image, writeTailscaleStubs } from "../support.ts";

const key = "fake-smol-cloud-key";

serveProvider(
  {
    name: "smol-cloud",
    image,
    fake: (dir, record) =>
      Effect.map(fakeSmolCloud({ dir, key, onCall: record.call }), (fake) => {
        if (fakeTailnet) {
          writeTailscaleStubs(path.join(dir, "bin"));
        }

        return {
          url: fake.url,
          key,
          faults: fake.faults,
          holdCapture: fake.holdCapture,
          drift: {
            _tag: "never",
            because:
              "a smol cloud machine's name holds its instance, which a host isn't told by the machine's name",
          },
        };
      }),
    layer: (api, host) =>
      SmolCloud.layer({ apiKeyFile: api.keyFile, api: api.url }, host),
  },
  import.meta.filename
);

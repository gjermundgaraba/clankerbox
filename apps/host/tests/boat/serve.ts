import { Duration, Effect, Layer } from "effect";

import * as Boat from "../../src/platform/boat/boat.ts";
import { fakeBoat, fakeBoatSsh } from "../fake-boat.ts";
import { serveProvider } from "../serving.ts";

const warmSeconds = process.env["CLANKERBOX_FAKE_BOAT_WARM_SECONDS"];

serveProvider(
  {
    name: "boat",
    image: Boat.image,
    fake: (dir, record) =>
      Effect.map(
        fakeBoat({
          dir,
          keepsStoppedFor:
            warmSeconds === undefined
              ? undefined
              : Duration.seconds(Number(warmSeconds)),
          onCall: (line, request) => {
            record.call(line);
            record.request(request);
          },
        }),
        (fake) => ({
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
  },
  import.meta.filename
);

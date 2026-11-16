import { Duration } from "effect";

import { boat } from "../providers.ts";
import { serveProvider } from "../serving.ts";

const warmSeconds = process.env["CLANKERBOX_FAKE_BOAT_WARM_SECONDS"];

serveProvider(
  boat(
    warmSeconds === undefined
      ? undefined
      : Duration.seconds(Number(warmSeconds))
  ),
  import.meta.filename
);

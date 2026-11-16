import { smolCloud } from "../providers.ts";
import { serveProvider } from "../serving.ts";

serveProvider(smolCloud(), import.meta.filename);

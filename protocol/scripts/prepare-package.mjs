import { copyFileSync, rmSync } from "node:fs";

// Packing always starts clean: removed descriptors must not survive in dist.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
copyFileSync(new URL("../../LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));

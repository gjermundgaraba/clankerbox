import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const protocol = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(protocol, "package.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "clankerbox-sdk-"));
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  // Release CI supplies the exact tarball it will publish. Local/PR checks pack one.
  let archive = process.argv[2] && resolve(process.argv[2]);
  if (!archive) {
    run("pnpm", ["pack", "--pack-destination", temporary], protocol);
    const archives = readdirSync(temporary).filter((name) => name.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    archive = join(temporary, archives[0]);
  }
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // No adjacent source checkout, dev dependencies, or consumer lifecycle scripts.
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", archive]);
  const installed = join(temporary, "node_modules", manifest.name);
  const packed = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(packed.name, "@gjermundgaraba/clankerbox-sdk");
  assert.equal(packed.version, manifest.version);
  assert.notEqual(packed.private, true);
  assert.equal(packed.license, "MIT");
  assert.equal(packed.publishConfig.access, "public");
  assert.deepEqual(readdirSync(installed).sort(), ["LICENSE", "README.md", "dist", "package.json"]);
  assert.equal(readFileSync(join(installed, "LICENSE"), "utf8"),
    readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"));

  for (const entry of Object.values(packed.exports)) {
    assert.ok(readFileSync(join(installed, entry.types)).length);
    assert.ok(readFileSync(join(installed, entry.import)).length);
  }
  writeFileSync(join(temporary, "smoke.mjs"), `
    import assert from "node:assert/strict";
    import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
    import * as sdk from "${manifest.name}";
    for (const subpath of ["resources", "machine", "session", "host", "profile"]) {
      const descriptors = await import("${manifest.name}/" + subpath);
      assert.ok(Object.keys(descriptors).length);
      for (const [name, value] of Object.entries(descriptors)) assert.equal(sdk[name], value);
    }
    const session = create(sdk.SessionSchema, { offset: 9007199254741993n });
    assert.equal(fromBinary(sdk.SessionSchema, toBinary(sdk.SessionSchema, session)).offset, session.offset);
    assert.equal(sdk.SessionService.method.attachSession.methodKind, "bidi_streaming");
    assert.equal(sdk.MachineService.typeName, "clankerbox.v1.MachineService");
    assert.equal(sdk.HostService.typeName, "clankerbox.v1.HostService");
  `);
  run(process.execPath, ["smoke.mjs"]);

  writeFileSync(join(temporary, "consumer.mts"), `
    import { create } from "@bufbuild/protobuf";
    import { SessionSchema, type Session } from "${manifest.name}";
    import { MachineSchema } from "${manifest.name}/resources";
    import { MachineService } from "${manifest.name}/machine";
    import { SessionService } from "${manifest.name}/session";
    import { HostService } from "${manifest.name}/host";
    import { ProfileService, HostProfileService } from "${manifest.name}/profile";
    const session: Session = create(SessionSchema, { offset: 1n });
    const offset: bigint = session.offset;
    const machineId: string = create(MachineSchema).id;
    const services = [MachineService, SessionService, HostService, ProfileService, HostProfileService];
    void [offset, machineId, services];
  `);
  writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: [] },
    files: ["consumer.mts"],
  }));
  run(join(protocol, "node_modules", ".bin", "tsc"), ["-p", join(temporary, "tsconfig.json")]);
  console.log("Packed SDK: runtime imports, declarations, metadata and license passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

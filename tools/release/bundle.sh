#!/bin/sh
# Bundle each built SEA with its notices into tools/release/dist/clankerbox-<version>-<target>.tar.gz,
# beside <bundle>.sha256, which `sha256sum -c` and `shasum -a 256 -c` check.
# Usage: bundle.sh [TARGET...]; by default, every target build-sea.sh has built. The version
# is the SDK's, which the binaries share. A bundle holds, at its top level:
#   clankerbox                       the SEA binary
#   LICENSE                          clankerbox's own
#   notices/node/LICENSE             Node's, from the archive build-sea.sh verified
#   notices/npm/licenses.json        every production dependency of apps/clankerbox, its
#                                    workspace packages' included, from `pnpm licenses list`
#   notices/npm/<name>@<version>/    that package's own license and notice files
# A package that ships no license file is listed in licenses.json with "files": [].
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$here/dist"
version=$(node -p 'require(process.argv[1]).version' "$root/packages/contract/package.json")
if command -v sha256sum >/dev/null; then sha256() { sha256sum "$1"; }; else sha256() { shasum -a 256 "$1"; }; fi
# Owned by root:0 in the archive. bsdtar must not add AppleDouble (._*) or xattr entries.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  pack() { tar --owner=0 --group=0 --numeric-owner -czf "$@"; }
else
  pack() { COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname root --no-mac-metadata --no-xattrs --no-acls --no-fflags -czf "$@"; }
fi

if [ $# -eq 0 ]; then
  for target in darwin-arm64 linux-x64; do
    if [ -x "$out/$target/clankerbox" ]; then set -- "$@" "$target"; fi
  done
  [ $# -gt 0 ] || { echo "no SEA in $out: run build-sea.sh first" >&2; exit 1; }
fi
for target in "$@"; do
  [ -x "$out/$target/clankerbox" ] && [ -f "$out/$target/node-LICENSE" ] \
    || { echo "missing $out/$target/clankerbox or node-LICENSE: run build-sea.sh $target" >&2; exit 1; }
done

notices="$out/notices.part"
rm -rf "$notices" && mkdir -p "$notices/npm"
(cd "$root" && pnpm --filter '@clankerbox/clankerbox...' licenses list --prod --json) >"$notices/pnpm-licenses.json"
# pnpm's listing names local paths; licenses.json keeps everything but those.
node --input-type=module - "$notices/pnpm-licenses.json" "$notices/npm" <<'NODE'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [listing, out] = process.argv.slice(2);
const noticeName = /^(licen[cs]e|copying|notice|copyright)/i;
const index = [];
for (const [license, packages] of Object.entries(JSON.parse(readFileSync(listing, "utf8")))) {
  for (const { name, versions, paths, homepage } of packages) {
    versions.forEach((version, i) => {
      const files = readdirSync(paths[i])
        .filter((file) => noticeName.test(file) && statSync(join(paths[i], file)).isFile())
        .sort();
      const dir = join(out, `${name}@${version}`);
      if (files.length > 0) mkdirSync(dir, { recursive: true });
      for (const file of files) copyFileSync(join(paths[i], file), join(dir, file));
      index.push({ name, version, license, homepage, files });
    });
  }
}
index.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
writeFileSync(join(out, "licenses.json"), `${JSON.stringify(index, null, 2)}\n`);
NODE

for target in "$@"; do
  name="clankerbox-$version-$target"
  stage="$out/$name"
  rm -rf "$stage" && mkdir -p "$stage/notices/node"
  cp "$out/$target/clankerbox" "$stage/clankerbox"
  cp "$root/LICENSE" "$stage/LICENSE"
  cp "$out/$target/node-LICENSE" "$stage/notices/node/LICENSE"
  cp -R "$notices/npm" "$stage/notices/npm"
  chmod -R u=rwX,go=rX "$stage"
  (cd "$stage" && pack "$out/$name.tar.gz" clankerbox LICENSE notices)
  (cd "$out" && sha256 "$name.tar.gz" >"$name.tar.gz.sha256")
  rm -rf "$stage"
  echo "bundled $out/$name.tar.gz"
done
rm -rf "$notices"

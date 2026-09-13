# Release inputs

This directory owns the qualified engine pins and exact local patch. `pins.json`
binds upstream commits, platform engine binaries, runtime libraries and the arm64
static Linux agent. `linux-amd64-image-sources.json` binds the amd64 static agent
and pristine image archives. `source.json` binds the required engine source
license and Cargo lock file.

Release assembly and native qualification consume these files directly.

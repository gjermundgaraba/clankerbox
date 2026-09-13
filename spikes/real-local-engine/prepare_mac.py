#!/usr/bin/env python3
"""Allocate a fresh private test profile; does not launch VMs."""
import json,pathlib,tempfile,shutil,os
w=pathlib.Path(__file__).resolve().parents[2]/'.work/real-local-engine';config=w/'mac.json'
if config.exists():raise SystemExit('mac.json already exists; preserve it or choose a fresh worktree')
r=pathlib.Path(tempfile.mkdtemp(prefix='cbre-',dir='/private/tmp'));release=w/'smolvm-1.14.1-darwin-arm64'
for d in ['h','d','c','config','r','empty-docker']:(r/d).mkdir()
shutil.copytree(release/'agent-rootfs',r/'agent-rootfs',symlinks=True)
shutil.copy(w/'agent-target/aarch64-unknown-linux-musl/release/smolvm-agent',r/'agent-rootfs/usr/local/bin/smolvm-agent')
shutil.copy(w/'sentinel-aarch64',r/'agent-rootfs/usr/local/bin/gate-sentinel')
for d in ['mnt/overlay','mnt/storage','mnt/newroot','mnt/rosetta']:(r/'agent-rootfs'/d).mkdir(parents=True,exist_ok=True)
env={'HOME':str(r/'h'),'XDG_DATA_HOME':str(r/'d'),'XDG_CACHE_HOME':str(r/'c'),'XDG_CONFIG_HOME':str(r/'config'),'XDG_RUNTIME_DIR':str(r/'r'),'DOCKER_CONFIG':str(r/'empty-docker'),'SMOLVM_AGENT_ROOTFS':str(r/'agent-rootfs'),'SMOLVM_LIB_DIR':str(release/'lib'),'DYLD_LIBRARY_PATH':str(release/'lib'),'SMOLVM_PUBLISH_ADDR':'127.0.0.1','SMOLVM_EGRESS_FLOOR':'strict','SMOLVM_BOOT_DEBUG':'1','RUST_LOG':'smolvm=debug'}
config.write_text(json.dumps({'root':str(r),'binary':str(w/'target/debug/smolvm'),'env':env,'domain':'gui/'+str(os.getuid()),'label':'org.clankerbox.engine-gate.'+r.name+'.parent'},indent=2));print(r)

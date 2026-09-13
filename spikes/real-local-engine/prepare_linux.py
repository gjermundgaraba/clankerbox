#!/usr/bin/env python3
import pathlib,shutil,json,sys,os
r=pathlib.Path(sys.argv[1]);b=pathlib.Path('/home/clanker/clankerbox/versions/1.14.1')
if not str(r).startswith('/home/clanker/cbre.') or list(r.iterdir()):raise RuntimeError('require newly allocated empty gate root')
for d in ['h','d','c','config','r','empty-docker','bin']: (r/d).mkdir()
shutil.copytree(b/'upstream/smolvm-1.14.1-linux-x86_64/agent-rootfs',r/'agent-rootfs',symlinks=True)
shutil.copy(b/'guest-support/usr/local/bin/smolvm-agent',r/'agent-rootfs/usr/local/bin/smolvm-agent')
shutil.copy(b/'bin/smolvm',r/'bin/smolvm')
for p in (b/'upstream/smolvm-1.14.1-linux-x86_64').glob('*template*'):shutil.copy(p,r/'bin'/p.name)
for d in ['mnt/overlay','mnt/storage','mnt/newroot']:(r/'agent-rootfs'/d).mkdir(parents=True,exist_ok=True)
env={'HOME':str(r/'h'),'XDG_DATA_HOME':str(r/'d'),'XDG_CACHE_HOME':str(r/'c'),'XDG_CONFIG_HOME':str(r/'config'),'XDG_RUNTIME_DIR':str(r/'r'),'DOCKER_CONFIG':str(r/'empty-docker'),'SMOLVM_AGENT_ROOTFS':str(r/'agent-rootfs'),'SMOLVM_LIB_DIR':str(b/'lib'),'LD_LIBRARY_PATH':str(b/'lib'),'SMOLVM_PUBLISH_ADDR':'127.0.0.1','SMOLVM_EGRESS_FLOOR':'strict','RUST_LOG':'smolvm=debug'}
(r/'config.json').write_text(json.dumps({'root':str(r),'binary':str(r/'bin/smolvm'),'env':env},indent=2))

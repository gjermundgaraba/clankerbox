#!/usr/bin/env python3
"""Explicit isolated engine command driver; never discovers/adopts user machines."""
import json,os,pathlib,subprocess,sys,time
CONFIG=pathlib.Path(os.environ.get('ENGINE_GATE_CONFIG',str(pathlib.Path(__file__).resolve().parents[2]/'.work/real-local-engine/mac.json')))
def main():
 c=json.loads(CONFIG.read_text()); root=pathlib.Path(c['root']); 
 if not str(root).startswith(('/private/tmp/cbre-','/home/clanker/cbre.')): raise RuntimeError('refusing non-gate root')
 env=os.environ.copy();env.update(c['env'])
 argv=[c['binary'],*sys.argv[1:]]
 start=time.time(); p=subprocess.run(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
 row=dict(argv=argv,start=start,end=time.time(),exit=p.returncode,stdout=p.stdout.decode(errors='replace'),stderr=p.stderr.decode(errors='replace'))
 with (root/'commands.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
 print(row['stdout'],end='');print(row['stderr'],end='',file=sys.stderr);sys.exit(p.returncode)
if __name__=='__main__':main()

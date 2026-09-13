#!/usr/bin/env python3
"""Install one explicit, non-restarting launchd job in the active isolated gate root."""
import json,pathlib,plistlib,subprocess,sys,os
p=pathlib.Path(os.environ.get('ENGINE_GATE_CONFIG',str(pathlib.Path(__file__).resolve().parents[2]/'.work/real-local-engine/mac.json')));c=json.loads(p.read_text());r=pathlib.Path(c['root']);name=sys.argv[1]
if not str(r).startswith('/private/tmp/cbre-') or name not in ['parent','child','restore1','restore2']:raise RuntimeError('gate scope')
label=c['label'].removesuffix('parent')+name
job={'Label':label,'ProgramArguments':[c['binary'],*sys.argv[2:]],'EnvironmentVariables':c['env'],'RunAtLoad':False,'KeepAlive':False,'AbandonProcessGroup':True,'StandardOutPath':str(r/('launch-'+name+'.log')),'StandardErrorPath':str(r/('launch-'+name+'.log'))}
f=r/(name+'.plist');f.write_bytes(plistlib.dumps(job));subprocess.run(['launchctl','bootstrap',c['domain'],str(f)],check=True);subprocess.run(['launchctl','kickstart',c['domain']+'/'+label],check=True)

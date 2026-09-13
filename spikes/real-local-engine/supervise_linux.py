#!/usr/bin/env python3
import json,pathlib,subprocess,sys
r=pathlib.Path(sys.argv[1]);c=json.loads((r/'config.json').read_text());name=sys.argv[2];args=sys.argv[3:]
if not str(r).startswith('/home/clanker/cbre.') or name not in ['parent','child','restore']:raise RuntimeError('gate ownership')
label='clankerbox-engine-'+r.name+'-'+name+'.service';unit=r/label
lines=['[Unit]','Description=Isolated engine gate','[Service]','Type=oneshot','RemainAfterExit=yes','Restart=no','KillMode=control-group','SendSIGKILL=no','TimeoutStartSec=240','TimeoutStopSec=30','MemoryMax=3G','CPUQuota=200%']
for k,v in c['env'].items():lines.append('Environment="'+k+'='+v+'"')
lines+=['ExecStart='+c['binary']+' '+ ' '.join(args),'StandardOutput=append:'+str(r/(name+'.log')),'StandardError=append:'+str(r/(name+'.log'))]
unit.write_text('\n'.join(lines)+'\n');subprocess.run(['systemctl','--user','link',str(unit)],check=True);subprocess.run(['systemctl','--user','daemon-reload'],check=True);subprocess.run(['systemctl','--user','start',label],check=True)

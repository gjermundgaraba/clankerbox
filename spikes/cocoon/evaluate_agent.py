#!/usr/bin/env python3
"""Re-evaluate exported Cocoon evidence, including host continuity and overlap."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'real-agent'))
from evaluate import evaluate

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence',type=Path)
    parser.add_argument('--recovery',action='store_true')
    args=parser.parse_args()
    evidence=json.loads(args.evidence.read_text())
    phase='recovery_reports' if args.recovery else 'reports'
    reports=evidence['phases'][phase]
    result=evaluate(list(reports.values()),evidence['ordering'],True,args.recovery)
    errors=result['errors']
    checkpoint=evidence['phases']['active_checkpoint']
    if not checkpoint['barrierWaiting']:errors.append('NoActiveToolAtCapture')
    for name,report in reports.items():
        if report['identity']!=checkpoint['identity']:errors.append(name+':CapturedApplicationIdentityChanged')
        if report['barrierIdentity']!=checkpoint['barrierIdentity']:errors.append(name+':CapturedToolIdentityChanged')
    runtime=evidence['runtime'].values()
    if len({v['id'] for v in runtime})!=3 or len({v['pid'] for v in runtime})!=3:
        errors.append('ThreeDistinctLiveVMsRequired')
    for vm in runtime:
        if vm['config']['cpu']!=2 or vm['config']['memory']!=2*1024**3:errors.append('GuestBudgetMismatch')
    for reset in evidence['relay_resets'].values():
        if not (reset['ok'] and reset['oldTunnels']>=1 and reset['oldTunnelsRemaining']==0 and
                reset['pid']==evidence['relay_baseline']['pid']):errors.append('RelayResetContinuityFailed')
    overlap={}
    for name,calls in evidence['concurrent_calls'].items():
        overlap[name]=(min(v['end_ns'] for v in calls.values())-max(v['start_ns'] for v in calls.values()))/1e6
        if len(calls)!=3 or overlap[name]<=0:errors.append(name+':ThreeRequestsDidNotOverlap')
    if args.recovery and any(v['disconnected_active_tunnels']<1 for v in evidence['network_fault'].values()):
        errors.append('NoActualActiveTunnelDisconnected')
    if evidence['cleanup']!='pass' or evidence['cleanup_vms'] or evidence['cleanup_snapshots']:
        errors.append('CleanupIncomplete')
    result['pass']=not errors
    result['host_checks']='pass' if not errors else 'fail'
    result['overlap_ms']=overlap
    print(json.dumps(result,sort_keys=True))
    return 0 if result['pass'] else 1

if __name__=='__main__':raise SystemExit(main())

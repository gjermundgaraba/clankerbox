#!/usr/bin/env python3
"""Calibrate guest heartbeat against a known suspension of an owned VMM process.

This is NOT a native snapshot pause measurement. pidfds avoid signaling a reused
PID; SIGCONT is sent in finally before any guest query or cleanup.
"""
import argparse
import fcntl
import grp
import importlib.util
import json
import os
from pathlib import Path
import signal
import time

ROOT = Path('/home/clanker/clankerbox-latency.RPxPe6')
GRANT = 'latency-20260905'


def module(runtime):
    location = ROOT / runtime / (runtime + '.py')
    spec = importlib.util.spec_from_file_location('calibration_' + runtime, location)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def measure(call, identity):
    trials = []
    for index in range(5):
        before = call('reset_metrics')
        time.sleep(.2)
        baseline = call('status')
        call('reset_metrics')
        first = identity()
        pid = first['pid']
        descriptor = os.pidfd_open(pid)
        try:
            second = identity()
            birth = 'start_time' if 'start_time' in first else 'starttime_ticks'
            if second['pid'] != pid or second[birth] != first[birth]:
                raise RuntimeError('VMM identity changed while opening pidfd')
            sent_ns = time.monotonic_ns()
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGSTOP)
                deadline = time.monotonic() + 1
                while True:
                    thread_states = {p.name: (p/'stat').read_text().rsplit(')', 1)[1].split()[0]
                                     for p in Path('/proc', str(pid), 'task').iterdir()}
                    if thread_states and all(state == 'T' for state in thread_states.values()):
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError('all owned VMM threads did not enter stopped state')
                    time.sleep(.001)
                stopped_ns = time.monotonic_ns()
                time.sleep(.1)
            finally:
                resume_ns = time.monotonic_ns()
                signal.pidfd_send_signal(descriptor, signal.SIGCONT)
            immediate_after = call('status')
            time.sleep(.02)
            after = call('status')
            if after['heartbeat']['samples'] <= immediate_after['heartbeat']['samples']:
                raise RuntimeError('heartbeat did not advance after resume')
            for key in ('pid', 'start_monotonic_ns', 'ram_marker', 'branch', 'disk_branch'):
                if before[key] != after[key]:
                    raise RuntimeError('guest identity changed during calibration: ' + key)
            trials.append(dict(index=index, vmm_pid=pid, vmm_birth=first[birth],
                               signal_stop_ns=sent_ns, stopped_observed_ns=stopped_ns,
                               signal_continue_ns=resume_ns,
                               observed_stopped_hold_ms=(resume_ns-stopped_ns)/1e6,
                               signal_bracket_ms=(resume_ns-sent_ns)/1e6,
                               stopped_thread_states=thread_states,
                               baseline=baseline, immediate_after=immediate_after, after=after))
        finally:
            os.close(descriptor)
    return trials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', choices=('cocoon', 'smolvm'), required=True)
    args = parser.parse_args()
    def terminate(signum, frame):
        raise InterruptedError('calibration interrupted by signal ' + str(signum))
    signal.signal(signal.SIGTERM, terminate)
    if os.geteuid() != 0 or ROOT.resolve() != ROOT:
        raise RuntimeError('root in the exact benchmark scope required')
    authorization = json.loads((ROOT/'authorization.json').read_text())
    if authorization.get('grant') != GRANT or not authorization.get('timing_authorized'):
        raise RuntimeError('timing gate closed')
    os.sched_setaffinity(0, range(4, 12))
    lock = (ROOT/'measure.lock').open('r+')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    mod = module(args.runtime)
    result = dict(schema_version=1, runtime=args.runtime, case='calibration', variant='idle',
                  trial=90090, repetition=90090, block='smoke', status='fail', metrics={},
                  interpretation='Known host VMM-process suspension, not a native snapshot pause timer.')
    output = ROOT/args.runtime/'calibration.json'
    if output.exists():
        raise RuntimeError('calibration output exists; do not overwrite evidence')
    if args.runtime == 'cocoon':
        config = argparse.Namespace(root=str(ROOT/'cocoon'), grant=GRANT,
            lock=str(ROOT/'measure.lock'), guest=str(ROOT/'shared/latency-guest'), cpus='4-11',
            variant='idle', run_case='calibration', block='smoke', trial_offset=90090)
        runner = mod.Experiment(config)
        runner.trial = 'calibration-idle-90090'
        network_before = mod.networks()
        runner.initialize_group()
        try:
            runner.run_vm('cl-source')
            runner.wait(lambda: runner.status('cl-source'))
            result['trials'] = measure(lambda op: runner.request('cl-source', {'op':op}),
                                      lambda: runner.inspect('cl-source')['live_identity'])
            result['status'] = 'pass'
        except Exception as error:
            result['error'] = repr(error)
        finally:
            try:
                runner.cleanup_objects()
                runner.close_group()
                if mod.networks() != network_before:
                    raise RuntimeError('network inventory changed')
                result['cleanup'] = 'pass'
            except Exception as error:
                result.update(status='fail', cleanup='fail', cleanup_error=repr(error))
            output.write_text(json.dumps(result, indent=2)+'\n')
            runner.append('samples.jsonl', result)
    else:
        mod.validate_cgroup_owner()
        mod.validate_cgroup()
        if mod.inventory():
            raise RuntimeError('owned VMMs already exist')
        (mod.CGROUP/'cgroup.procs').write_text(str(os.getpid()))
        os.setgroups([])
        os.setgid(grp.getgrnam('kvm').gr_gid)
        os.setuid(1000)
        config = argparse.Namespace(root=ROOT/'smolvm', profile='idle', case='cold', trial=90090)
        runner = mod.Runner(config)
        try:
            if runner.records():
                raise RuntimeError('private DB not empty')
            source = runner.create()
            runner.start(source, 'cold')
            result['trials'] = measure(lambda op: runner.call(source, op), lambda: runner.observe(source))
            result['status'] = 'pass'
        except Exception as error:
            result['error'] = repr(error)
        finally:
            try:
                runner.cleanup()
                result['cleanup'] = 'pass'
            except Exception as error:
                result.update(status='fail', cleanup='fail', cleanup_error=repr(error))
            output.write_text(json.dumps(result, indent=2)+'\n')
            with (ROOT/'smolvm/samples.jsonl').open('a') as stream:
                stream.write(json.dumps(result)+'\n')
            runner.commands.close()
    print(json.dumps(dict(path=str(output), status=result['status'], error=result.get('error'))))
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())

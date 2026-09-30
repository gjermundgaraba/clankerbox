#!/usr/bin/env python3
"""Print the JSON argv for `smolvm machine exec -i` into a clankerbox 0.11.0 VM.

The environment and runtime name come from the host's own supervisor job for
that VM: the launchd plist on macOS, the systemd unit on Linux. This is the
same env the Go host uses for trusted guest exec (internal/host/runtime.go).
Usage: execargv.py JOB_FILE -- COMMAND...
"""
import json
import plistlib
import re
import shlex
import sys

job, command = sys.argv[1], sys.argv[sys.argv.index('--') + 1:]
if job.endswith('.plist'):
    data = plistlib.load(open(job, 'rb'))
    env = data['EnvironmentVariables']
    program = data['ProgramArguments']
else:
    env, program = {}, None
    for line in open(job):
        line = line.strip()
        if line.startswith('Environment='):
            for item in shlex.split(line[len('Environment='):]):
                key, _, value = item.partition('=')
                env[key] = value
        elif line.startswith('ExecStart='):
            program = shlex.split(re.sub(r'^ExecStart=[@\-:+!]*', '', line))
smolvm = program[0]
name = program[program.index('--name') + 1]
argv = ['env', '-i'] + [f'{k}={v}' for k, v in env.items()] + [
    smolvm, 'machine', 'exec', '--name', name, '-i', '--'] + command
print(json.dumps(argv))

#!/usr/bin/env python3
"""vmexec.py JOB_FILE COMMAND... — exec into the VM with the host's exact env."""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = json.loads(subprocess.run([sys.executable, os.path.join(here, 'execargv.py'), sys.argv[1], '--'] + sys.argv[2:],
                                 capture_output=True, text=True, check=True).stdout)
os.execvp(argv[0], argv)

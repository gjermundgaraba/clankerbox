#!/usr/bin/env python3
"""q-sea-min harness (not part of the measured pipeline).

Builds three SEA variants with build.sh inside a work run, inspects and times
them on this Mac, then runs the linux-x64 binaries on the Linux test host under
~/clankerbox-rewrite/runs/<run id>/, which a registered cleanup removes.
"""
import gzip
import json
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
from scripts.work_runs import WorkRun  # noqa: E402

REMOTE = 'clanker@37.27.63.112'
SSH = ['ssh', '-o', 'BatchMode=yes', REMOTE]
NODE = '26.10.0'
RUNS = 20


def main():
    with WorkRun('sea-min') as run:
        Driver(run).go()
        print(f'run: {run.path.name}')


class Driver:
    def __init__(self, run):
        self.run, self.ev, self.scr = run, run.evidence, run.scratch
        self.results = {'run_id': run.path.name}
        self.log = (self.ev / 'commands.log').open('a')
        (self.scr / 'tmp').mkdir()
        self.env = dict(os.environ, TMPDIR=str(self.scr / 'tmp'),
                        npm_config_cache=str(self.scr / 'npm-cache'),
                        NODE_CACHE=str(self.scr / 'node'))

    def sh(self, cmd, check=True, env=None, cwd=None):
        self.log.write(f'\n$ {" ".join(map(str, cmd))}\n')
        self.log.flush()
        start = time.perf_counter()
        p = subprocess.run(list(map(str, cmd)), capture_output=True, text=True, env=env or self.env, cwd=cwd, timeout=900)
        self.log.write(f'[exit {p.returncode} in {time.perf_counter() - start:.1f}s]\n{p.stdout}{p.stderr}')
        self.log.flush()
        if check and p.returncode:
            raise RuntimeError(f'failed ({p.returncode}): {cmd}\n{p.stderr}')
        return p

    def save(self):
        (self.ev / 'results.json').write_text(json.dumps(self.results, indent=2) + '\n')

    def go(self):
        try:
            self.bundle()
            self.build()
            self.inspect()
            self.local()
            self.remote()
        finally:
            self.save()

    # -- bundle a trivial Effect program (esbuild), only to compare with main.cjs
    def bundle(self):
        b = self.scr / 'bundle'
        b.mkdir()
        self.sh(['npm', 'install', '--prefix', b, '--no-audit', '--no-fund', 'effect@4.0.0', 'esbuild@0.28.2'])
        shutil.copy(HERE / 'effect-main.mjs', b / 'effect-main.mjs')
        esbuild = b / 'node_modules' / '.bin' / 'esbuild'
        common = ['--bundle', '--platform=node', '--target=node26', '--log-level=warning']
        self.sh([esbuild, b / 'effect-main.mjs', *common, '--format=cjs', f'--outfile={b / "effect.cjs"}'])
        self.sh([esbuild, b / 'effect-main.mjs', *common, '--format=esm', f'--outfile={b / "effect.mjs"}'])
        self.sh([esbuild, b / 'effect-main.mjs', *common, '--format=esm', '--minify', f'--outfile={b / "effect.min.mjs"}'])
        self.results['bundle_bytes'] = {f: (b / f).stat().st_size for f in ['effect.cjs', 'effect.mjs', 'effect.min.mjs']}
        self.results['main_cjs_bytes'] = (HERE / 'main.cjs').stat().st_size

    # -- the measured pipeline: build.sh, three times (first one downloads)
    def build(self):
        b = self.scr / 'bundle'
        self.variants = {'min': (HERE / 'main.cjs', 'commonjs'), 'effect-cjs': (b / 'effect.cjs', 'commonjs'),
                         'effect-esm': (b / 'effect.mjs', 'module')}
        times = {}
        for name, (main, fmt) in list(self.variants.items()):
            start = time.perf_counter()
            p = self.sh(['sh', HERE / 'build.sh', self.scr / name, main, fmt], check=name == 'min')
            times[name] = round(time.perf_counter() - start, 1)
            self.results.setdefault('build_smoke', {})[name] = [p.returncode, p.stdout.strip(), p.stderr.strip()[-800:]]
            if p.returncode:
                del self.variants[name]
        self.results['build_seconds'] = times
        self.node = {t: self.scr / 'node' / f'node-v{NODE}-{t}' / 'bin' / 'node' for t in ['darwin-arm64', 'linux-x64']}
        # Extra, outside build.sh: darwin-only code cache variant (native build, so allowed).
        cfg = self.scr / 'effect-cjs-cc.json'
        out = self.scr / 'effect-cjs-cc' / 'clankerbox'
        out.parent.mkdir()
        cfg.write_text(json.dumps(dict(main=str(b / 'effect.cjs'), executable=str(self.node['darwin-arm64']), output=str(out),
                                       disableExperimentalSEAWarning=True, useCodeCache=True, execArgvExtension='none')))
        self.sh([self.node['darwin-arm64'], '--build-sea', cfg])
        self.sh(['codesign', '--force', '--sign', '-', '--options', 'runtime', '--entitlements', HERE / 'entitlements.plist', out])
        # Extra: the .app wrapper for D9 (Info.plist bound by codesign), inner executable runs.
        app = self.scr / 'Clankerbox.app'
        (app / 'Contents' / 'MacOS').mkdir(parents=True)
        shutil.copy(self.scr / 'min' / 'darwin-arm64' / 'clankerbox', app / 'Contents' / 'MacOS' / 'clankerbox')
        (app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps(dict(
            CFBundleIdentifier='net.garaba.clankerbox', CFBundleExecutable='clankerbox', CFBundleName='Clankerbox',
            CFBundlePackageType='APPL', CFBundleShortVersionString='0.0.0',
            NSLocalNetworkUsageDescription='Clankerbox reaches its key issuer on the local network.')))
        self.sh(['codesign', '--force', '--sign', '-', '--options', 'runtime', '--entitlements', HERE / 'entitlements.plist', app])
        self.app = app

    # -- static inspection
    def inspect(self):
        r = self.results
        sea = {n: {t: self.scr / n / t / 'clankerbox' for t in ['darwin-arm64', 'linux-x64']} for n in self.variants}
        self.sea = sea
        r['sizes_bytes'] = {
            'node_tar_xz': {t: (self.scr / 'node' / f'node-v{NODE}-{t}.tar.xz').stat().st_size for t in self.node},
            'official_node': {t: p.stat().st_size for t, p in self.node.items()},
            'sea': {n: {t: p.stat().st_size for t, p in ts.items()} for n, ts in sea.items()},
            'sea_gzip6': {t: len(gzip.compress(sea['min'][t].read_bytes(), 6)) for t in self.node},
        }
        tars = [self.scr / 'node' / f'node-v{NODE}-{t}.tar.xz' for t in self.node]
        r['xattr'] = {str(p.relative_to(self.scr)): self.sh(['xattr', '-l', p], check=False).stdout.strip()
                      for p in [*tars, self.node['darwin-arm64'], sea['min']['darwin-arm64']]}
        r['file'] = {str(p.relative_to(self.scr)): self.sh(['file', '-b', p]).stdout.strip()
                     for p in [*self.node.values(), sea['min']['darwin-arm64'], sea['min']['linux-x64']]}
        r['elf'] = {'official': elf(self.node['linux-x64']), 'sea': elf(sea['min']['linux-x64'])}
        cs = lambda p: self.sh(['codesign', '-dvv', '--entitlements', '-', p], check=False)
        r['codesign'] = {name: (lambda q: q.stdout + q.stderr)(cs(p)) for name, p in
                         [('official_node', self.node['darwin-arm64']), ('sea', sea['min']['darwin-arm64']), ('app', self.app)]}
        r['codesign_verify_app'] = (lambda q: [q.returncode, q.stderr.strip()])(
            self.sh(['codesign', '--verify', '--strict', '--deep', '-vv', self.app], check=False))
        spctl = lambda p: (lambda q: [q.returncode, (q.stdout + q.stderr).strip()])(
            self.sh(['spctl', '--assess', '--type', 'execute', '-vv', p], check=False))
        r['spctl'] = {'official_node': spctl(self.node['darwin-arm64']), 'sea': spctl(sea['min']['darwin-arm64']), 'app': spctl(self.app)}
        self.save()

    def probe(self, cmd, env=None):
        p = self.sh(cmd, check=False, env=env)
        return {'exit': p.returncode, 'stdout': p.stdout.strip(), 'stderr': p.stderr.strip()[:600]}

    # -- local behaviour and timings
    def local(self):
        s = self.sea['min']['darwin-arm64']
        node = self.node['darwin-arm64']
        link = self.scr / 'bin' / 'clankerbox'
        link.parent.mkdir()
        link.symlink_to(self.app / 'Contents' / 'MacOS' / 'clankerbox')
        bad_opts = dict(self.env, NODE_OPTIONS='--require=/nonexistent-q-sea-min.js')
        b = self.scr / 'bundle'
        self.results['local_roles'] = {
            **{f'sea {a}': self.probe([s, a]) for a in ['cli', 'server', 'host', '--help', '--version', 'bogus']},
            'sea --version with NODE_OPTIONS=--require=missing': self.probe([s, '--version'], env=bad_opts),
            'node main.cjs --version with NODE_OPTIONS=--require=missing': self.probe([node, HERE / 'main.cjs', '--version'], env=bad_opts),
            'sea node flag as argv[2]': self.probe([s, '--max-old-space-size=64']),
            'app inner exe host': self.probe([self.app / 'Contents' / 'MacOS' / 'clankerbox', 'host']),
            'symlink to app exe host': self.probe([link, 'host']),
            **{f'{n} sea cli': self.probe([self.sea[n]['darwin-arm64'], 'cli']) for n in self.sea if n != 'min'},
            'effect-cjs codecache sea cli': self.probe([self.scr / 'effect-cjs-cc' / 'clankerbox', 'cli']),
            'node effect.mjs': self.probe([node, b / 'effect.mjs']),
        }
        self.save()
        bench = lambda *cmd: json.loads(self.sh([sys.executable, HERE / 'bench.py', RUNS, *cmd]).stdout)['median_ms']
        self.results['local_startup_median_ms'] = {
            'sea --version': bench(s, '--version'),
            'sea cli (sqlite)': bench(s, 'cli'),
            'sea server': bench(s, 'server'),
            'sea host (re-execs cli)': bench(s, 'host'),
            **{f'sea {n}': bench(self.sea[n]['darwin-arm64'], 'cli') for n in self.sea if n != 'min'},
            'sea effect-cjs + code cache': bench(self.scr / 'effect-cjs-cc' / 'clankerbox', 'cli'),
            'node -e 0': bench(node, '-e', '0'),
            'node main.cjs --version': bench(node, HERE / 'main.cjs', '--version'),
            'node main.cjs cli': bench(node, HERE / 'main.cjs', 'cli'),
            'node effect.mjs (bundle)': bench(node, b / 'effect.mjs'),
            'node effect.min.mjs (bundle)': bench(node, b / 'effect.min.mjs'),
        }
        self.save()

    # -- Linux test host: ~/clankerbox-rewrite/runs/<run id>/ only
    def remote(self):
        rdir = f'clankerbox-rewrite/runs/{self.run.path.name}'
        (self.ev / 'resources.json').write_text(json.dumps({'remote_host': REMOTE, 'remote_dir': f'~/{rdir}'}, indent=2) + '\n')

        def teardown():
            self.sh([*SSH, f'{in_dir(rdir, "kill")}; rm -rf ~/{rdir} && test ! -e ~/{rdir}'])
            gone = self.sh([*SSH, f'test ! -e ~/{rdir} && test -z "$({in_dir(rdir, "echo")})" && echo absent'], check=False).stdout.strip()
            (self.ev / 'remote-cleanup.txt').write_text(f'~/{rdir}: {gone}\n')
            if gone != 'absent':
                raise RuntimeError(f'remote dir or processes remain: {rdir}')
        self.run.on_cleanup(teardown)

        stage = self.scr / 'upload'
        stage.mkdir()
        for n in self.variants:
            shutil.copy(self.sea[n]['linux-x64'], stage / f'sea-{n}')
        shutil.copy(self.scr / 'node' / f'node-v{NODE}-linux-x64.tar.xz', stage)
        for f in ['main.cjs', 'bench.py']:
            shutil.copy(HERE / f, stage)
        shutil.copy(self.scr / 'bundle' / 'effect.mjs', stage)
        self.sh([*SSH, f'mkdir -m 700 -p ~/{rdir}'])
        start = time.perf_counter()
        self.sh(['sh', '-c', f'tar -C "{stage}" -czf - . | ssh -o BatchMode=yes {REMOTE} "tar -C ~/{rdir} -xzf -"'])
        self.results['upload_seconds'] = round(time.perf_counter() - start, 1)
        self.sh([*SSH, f'cd ~/{rdir} && tar -xJf node-v{NODE}-linux-x64.tar.xz node-v{NODE}-linux-x64/bin/node'])
        node = f'./node-v{NODE}-linux-x64/bin/node'
        rsh = lambda c: (lambda p: {'exit': p.returncode, 'stdout': p.stdout.strip(), 'stderr': p.stderr.strip()[:600]})(
            self.sh([*SSH, f'cd ~/{rdir} && timeout 60 {c}'], check=False))
        self.results['remote_env'] = rsh('sh -c "uname -srm; ldd --version | head -1; sha256sum sea-min"')
        self.results['remote_roles'] = {
            **{f'sea {a}': rsh(f'./sea-min {a}') for a in ['cli', 'server', 'host', '--help', '--version']},
            'sea --version with NODE_OPTIONS=--require=missing': rsh('env NODE_OPTIONS=--require=/nonexistent-q-sea-min.js ./sea-min --version'),
            **{f'{n} sea cli': rsh(f'./sea-{n} cli') for n in self.variants if n != 'min'},
            'node effect.mjs': rsh(f'{node} effect.mjs'),
        }
        self.save()
        rb = lambda c: json.loads(rsh(f'python3 bench.py {RUNS} {c}')['stdout'])['median_ms']
        self.results['remote_startup_median_ms'] = {
            'sea --version': rb('./sea-min --version'),
            'sea cli (sqlite)': rb('./sea-min cli'),
            'sea server': rb('./sea-min server'),
            'sea host (re-execs cli)': rb('./sea-min host'),
            **{f'sea {n}': rb(f'./sea-{n} cli') for n in self.variants if n != 'min'},
            'node -e 0': rb(f'{node} -e 0'),
            'node main.cjs --version': rb(f'{node} main.cjs --version'),
            'node effect.mjs (bundle)': rb(f'{node} effect.mjs'),
        }
        self.results['remote_processes_after'] = self.sh([*SSH, in_dir(rdir, 'echo')]).stdout.strip() or 'none'
        self.save()


def in_dir(rdir, action):
    """Shell snippet: run `action PID` for each of our processes whose cwd is under the remote run dir."""
    return (f'for d in /proc/[0-9]*; do case "$(readlink $d/cwd 2>/dev/null)" in */{rdir}*) '
            f'{action} ${{d#/proc/}};; esac; done')


def elf(path):
    """ELF type and PT_LOAD segments (offset, vaddr, filesz, memsz, flags, align)."""
    data = path.read_bytes()[:1 << 16]
    e_type, = struct.unpack_from('<H', data, 16)
    phoff, = struct.unpack_from('<Q', data, 32)
    phentsize, phnum = struct.unpack_from('<HH', data, 54)
    loads = []
    with path.open('rb') as f:
        for i in range(phnum):
            f.seek(phoff + i * phentsize)
            p_type, flags, off, vaddr, _paddr, filesz, memsz, align = struct.unpack('<IIQQQQQQ', f.read(56))
            if p_type == 1:
                perms = ''.join(c for c, bit in zip('RWX', (4, 2, 1)) if flags & bit)
                loads.append([hex(off), hex(vaddr), hex(filesz), hex(memsz), perms, hex(align)])
    return {'e_type': {2: 'EXEC (non-PIE)', 3: 'DYN (PIE)'}.get(e_type, e_type), 'pt_load': loads, 'phnum': phnum}


if __name__ == '__main__':
    main()

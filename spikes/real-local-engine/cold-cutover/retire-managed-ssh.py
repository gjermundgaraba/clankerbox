import hashlib, json, os, pathlib, re, stat, sys

machine, config_sha, keys_sha = sys.argv[1:4]
verify = len(sys.argv) == 5 and sys.argv[4] == 'verify'
if os.geteuid() != 0:
    raise RuntimeError('root native administration required')

def no_old_processes():
    found = []
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            exe = pathlib.Path(os.readlink(entry / 'exe')).name
            args = (entry / 'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError, PermissionError, ProcessLookupError): continue
        if exe in ('sshd', 'sshd-session') or (exe.startswith('clankerbox-guest') and b'daemon' in args):
            found.append(entry.name)
    if found: raise RuntimeError('old managed processes survived cold boot: ' + ','.join(found))

no_old_processes()
config = pathlib.Path('/etc/ssh/sshd_config')
keys = pathlib.Path('/root/.ssh/authorized_keys')
claim = pathlib.Path('/etc/clankerbox')
terminal = re.compile(r'^restrict,command="/usr/local/bin/clankerbox-guest proxy" ssh-ed25519 [A-Za-z0-9+/]+=* clankerbox-terminal$')
if verify:
    if any((claim/name).exists() for name in ('ssh_host_ed25519_key','ssh_host_ed25519_key.pub')):
        raise RuntimeError('managed SSH private identity returned')
    if keys.exists() and any(terminal.fullmatch(line) for line in keys.read_text().splitlines()):
        raise RuntimeError('managed terminal key returned')
    if config.exists() and 'clankerbox' in config.read_text():
        raise RuntimeError('managed SSH config returned')
    print(json.dumps({'old_managed_processes':0,'managed_ssh_identity':False,'forced_terminal_key':False}))
    sys.exit(0)

if (claim/'owner').read_text().strip() != machine:
    raise RuntimeError('guest SSH claim belongs to another machine')
for path, digest in ((config, config_sha), (keys, keys_sha)):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
        raise RuntimeError('owned SSH file changed type/owner')
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError('owned SSH inventory changed: ' + str(path))
lines = keys.read_text().splitlines()
owned = [line for line in lines if terminal.fullmatch(line)]
if len(owned) != 1:
    raise RuntimeError('expected exactly one inventoried forced terminal key')
if 'HostKey /etc/clankerbox/ssh_host_ed25519_key' not in config.read_text() or 'PidFile /var/run/clankerbox-sshd.pid' not in config.read_text():
    raise RuntimeError('SSH config ownership markers absent')

# Retire only SSH activation links from this exclusively managed configuration;
# leave the installed package, system unit definitions and unrelated files intact.
activation=[]
for name in ('sockets.target.wants/ssh.socket','multi-user.target.wants/ssh.service','multi-user.target.wants/sshd.service'):
    path=pathlib.Path('/etc/systemd/system')/name
    if not os.path.lexists(path): continue
    if not path.is_symlink() or path.resolve().name not in ('ssh.socket','ssh.service','sshd.service'):
        raise RuntimeError('unexpected SSH activation entry: '+str(path))
    activation.append(path)
for directory in pathlib.Path('/etc').glob('rc[0-6S].d'):
    for path in directory.glob('S*ssh'):
        if not path.is_symlink() or path.resolve()!=pathlib.Path('/etc/init.d/ssh'):
            raise RuntimeError('unexpected SSH init activation entry')
        activation.append(path)
old_state=pathlib.Path('/root/.clankerbox')
metadata=('daemon.pid','guest.sock','guest.lock','daemon.log')
if old_state.exists() and any(p.name not in metadata for p in old_state.iterdir()):
    raise RuntimeError('old daemon state contains sessions or uninventoried files')
remaining=[line for line in lines if not terminal.fullmatch(line)]
temp=keys.with_name('authorized_keys.retire-tmp')
with temp.open('x') as f:
    os.chmod(temp,0o600)
    f.write(''.join(line+'\n' for line in remaining));f.flush();os.fsync(f.fileno())
os.replace(temp,keys)
for path in activation:path.unlink()
config.unlink()
for name in ('ssh_host_ed25519_key','ssh_host_ed25519_key.pub','prepared','owner'):
    path=claim/name
    if path.exists():path.unlink()
if not any(claim.iterdir()):claim.rmdir()
if old_state.exists():
    for name in metadata:
        path=old_state/name
        if os.path.lexists(path):path.unlink()
    old_state.rmdir()
pathlib.Path('/var/run/clankerbox-sshd.pid').unlink(missing_ok=True)
os.sync()
print(json.dumps({'machine_id':machine,'retired_activation':[str(p) for p in activation],'retired_forced_keys':1,'preserved_other_keys':len(remaining),'old_managed_processes':0}))

"""Prepare the Linux image contract at bundle assembly, never on VM startup.

Directory images are extracted as the host operator. The fixed workload UID
must differ from that operator: the host rejects that collision at admission.
Fresh guests establish bounded overlay ownership for private-state ancestors,
the guest executable, workload home and private daemon state.
"""

from pathlib import Path
import shutil
import stat

WORKLOAD_UID = 32001
CONTRACT = 'clankerbox-prepared-v1\n'


def image_path(root, name):
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('unsafe prepared image path: ' + name)
    return path


def add_account(root, name, fields, identity_index):
    path = image_path(root, 'etc/' + name)
    lines = path.read_text().splitlines()
    for line in lines:
        values = line.split(':')
        if (values[0] == 'clankerbox' or
                (len(values) > identity_index and values[identity_index] == str(WORKLOAD_UID)) or
                (name == 'group' and 'clankerbox' in values[-1].split(','))):
            raise ValueError('prepared image account collision in ' + name)
    path.write_text('\n'.join(lines + [fields]) + '\n')


def prepare(root, guest):
    root, guest = Path(root), Path(guest)
    # Refuse baking machine identity, sessions or host credentials into a seed.
    for name in ('var/lib/clankerbox-guest', 'etc/clankerbox', 'usr/local/share/clankerbox/prepared'):
        path = image_path(root, name)
        if path.exists():
            raise ValueError('image already contains private state or prepared marker: ' + name)
    for path in [root, *root.rglob('*')]:
        info = path.lstat()
        if info.st_uid == WORKLOAD_UID:
            raise ValueError('image entry owned by workload UID: ' + str(path))
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('image symlink escapes image: ' + str(path))
            continue
        if info.st_mode & 0o6000:
            raise ValueError('unsafe image file mode: ' + str(path))
        if stat.S_ISREG(info.st_mode):
            path.chmod(stat.S_IMODE(info.st_mode) & ~0o022)
        elif not stat.S_ISDIR(info.st_mode):
            raise ValueError('unsupported prepared image entry: ' + str(path))
    add_account(root, 'passwd', 'clankerbox:x:32001:32001::/home/clankerbox:/bin/sh', 2)
    add_account(root, 'group', 'clankerbox:x:32001:', 2)
    # Locked account: it is usable only through the privileged guest service.
    add_account(root, 'shadow', 'clankerbox:!:0:0:99999:7:::', 0)
    image_path(root, 'etc/shadow').chmod(0o600)
    # Only the guest's installation/state ancestors require normalization.
    # Preserve private, sticky and application directory modes everywhere else.
    for name in ('', 'home', 'home/clankerbox', 'var', 'var/lib', 'usr', 'usr/local',
                 'usr/local/bin', 'usr/local/share', 'usr/local/share/clankerbox'):
        path = image_path(root, name)
        path.mkdir(exist_ok=True, mode=0o755)
        path.chmod(0o755)
    image_path(root, 'tmp').chmod(0o1777)
    target = image_path(root, 'usr/local/bin/clankerbox-guest')
    if target.exists():
        raise ValueError('guest binary already present in base image')
    shutil.copyfile(guest, target)
    target.chmod(0o755)
    marker = image_path(root, 'usr/local/share/clankerbox/prepared')
    marker.write_text(CONTRACT)
    marker.chmod(0o644)

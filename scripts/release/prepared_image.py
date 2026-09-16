"""Install the root-session Linux image contract at bundle assembly."""

from pathlib import Path
import shutil
import stat

CONTRACT = 'clankerbox-prepared-v2\n'


def image_path(root, name):
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('unsafe prepared image path: ' + name)
    return path


def prepare(root, guest):
    root, guest = Path(root), Path(guest)
    # Refuse baking machine identity, sessions or host credentials into a seed.
    for name in ('var/lib/clankerbox-guest', 'etc/clankerbox', 'usr/local/share/clankerbox/prepared'):
        path = image_path(root, name)
        if path.exists():
            raise ValueError('image already contains private state or prepared marker: ' + name)
    # Image links must remain contained when the bundle is handled on the host.
    for path in [root, *root.rglob('*')]:
        info = path.lstat()
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('image symlink escapes image: ' + str(path))
        elif not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError('unsupported prepared image entry: ' + str(path))
    temporary = image_path(root, 'tmp')
    temporary.mkdir(exist_ok=True)
    temporary.chmod(0o1777)
    target = image_path(root, 'usr/local/bin/clankerbox-guest')
    if target.exists():
        raise ValueError('guest binary already present in base image')
    shutil.copyfile(guest, target)
    target.chmod(0o755)
    marker = image_path(root, 'usr/local/share/clankerbox/prepared')
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(CONTRACT)
    marker.chmod(0o644)

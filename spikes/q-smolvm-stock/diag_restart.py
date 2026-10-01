"""Diagnose the stop/start failure: inspect src's storage disk (APFS clone attached
read-only to a diag machine), then reproduce with a minimal write in the diag machine."""
from lib import *
set_log('diag-restart.log')
SRC, DIAG = PREFIX + 'src', PREFIX + 'diag'
d = smolvm('machine', 'data-dir', '--name', SRC, quiet=True)[1].strip()
clone = SCRATCH / 'src-storage-clone.raw'
if not clone.exists():
    sh(['cp', '-c', d + '/storage.raw', str(clone)], check=True)
smolvm('machine', 'create', '--name', DIAG, '--image', 'ubuntu:24.04', '--cpus', '2', '--mem', '1024', '--net',
       '--disk', f'{clone}:ro', check=True)
smolvm('machine', 'start', '--name', DIAG, check=True)
gx(DIAG, 'mkdir -p /mnt/s && mount -o ro,noload /dev/vdc /mnt/s 2>&1 || mount -o ro /dev/vdc /mnt/s; ls -la /mnt/s /mnt/s/overlays /mnt/s/overlays/*/ ; '
         'U=/mnt/s/overlays/persistent-clankerbox-rewrite-src/upper; ls -la $U; ls -la $U/etc 2>&1 | head; ls $U/etc/ssh 2>&1; ls $U/usr/sbin 2>&1 | head; du -sh $U; umount /mnt/s')
note('minimal reproduction: write /etc file, stop, start')
gx(DIAG, 'echo hi > /etc/q-marker; ls -la /etc/resolv.conf /etc/q-marker; sync')
smolvm('machine', 'stop', '--name', DIAG)
smolvm('machine', 'start', '--name', DIAG)
gx(DIAG, 'cat /etc/q-marker')
note('inspect resolv.conf in the src upper and which package replaced it')
gx(DIAG, 'mount -o ro,noload /dev/vdc /mnt/s; U=/mnt/s/overlays/persistent-clankerbox-rewrite-src/upper; ls -la $U/etc/resolv.conf $U/etc/.resolv.conf.systemd-resolved.bak; '
         'cat $U/etc/.resolv.conf.systemd-resolved.bak; ls -d $U/run/systemd/resolve 2>&1; '
         'grep -l "resolv.conf" $U/var/lib/dpkg/info/*.postinst 2>/dev/null; '
         'grep -E "^Package: (systemd|systemd-resolved|libpam-systemd)$" -A2 $U/var/lib/dpkg/status; umount /mnt/s')

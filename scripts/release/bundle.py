#!/usr/bin/env python3
"""Build an immutable installed runtime bundle; no toolchains run on end users' hosts.

Engine binaries must already be built from spikes/real-local-engine/pins.json
and runtime.patch. The image is the exported generic recipe output. This
assembler hashes every payload file and link and refuses to replace an output.
"""
import argparse, hashlib, json, os, pathlib, shutil, stat, subprocess, tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]

def sha(path):
    h = hashlib.sha256()
    if path.is_symlink(): h.update(os.readlink(path).encode())
    else:
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1 << 20), b''): h.update(block)
    return h.hexdigest()

def entry(path, name):
    info = path.lstat()
    record = {'path': name, 'mode': stat.S_IMODE(info.st_mode)}
    if stat.S_ISLNK(info.st_mode):
        record.update(type='symlink', mode=0o777, sha256=sha(path))
    elif stat.S_ISDIR(info.st_mode):
        record['type'] = 'directory'
    elif stat.S_ISREG(info.st_mode):
        record.update(type='file', sha256=sha(path))
    else:
        raise ValueError('unsupported payload type: ' + str(path))
    if record['mode'] & 0o6000:
        raise ValueError('setuid/setgid payload: ' + str(path))
    return record

def inventory(root, include_root=True):
    paths = ([root] if include_root else []) + sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix())
    return [entry(p, p.relative_to(root).as_posix()) for p in paths]

def content_digest(files):
    canonical = json.dumps(files, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    canonical = canonical.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    return hashlib.sha256(canonical.encode()).hexdigest()

def verify_inputs(args):
    pins = json.loads((ROOT/'spikes/real-local-engine/pins.json').read_text())
    expected_engine = pins['hashes']['target/debug/smolvm'] if args.os == 'darwin' else pins['linux_cli_sha256']
    if sha(args.engine) != expected_engine:
        raise ValueError('engine does not match qualified platform binary')
    if sha(ROOT/'spikes/real-local-engine/runtime.patch') != pins['runtime_patch_sha256']:
        raise ValueError('runtime patch does not match qualification')
    expected_agent = (pins['hashes']['agent-target/aarch64-unknown-linux-musl/release/smolvm-agent']
                      if args.arch == 'arm64' else json.loads((ROOT/'spikes/real-local-engine/evidence/linux-image/sources.json').read_text())['agent_sha256'])
    if sha(args.image/'usr/local/bin/smolvm-agent') != expected_agent:
        raise ValueError('image agent does not match qualified platform binary')
    if stat.S_IMODE(args.image.stat().st_mode) != 0o755:
        raise ValueError('image root must preserve guest mode 0755')

def package_archive(out):
    archive=out.with_name(out.name+'.tar.gz')
    if archive.exists():
        raise FileExistsError('refusing to replace archive: ' + str(archive))
    with tarfile.open(archive,'w:gz',format=tarfile.GNU_FORMAT,dereference=False,compresslevel=3) as tar:
        def normalize(info):
            info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
            # GNU headers preserve literal Unicode link bytes on Apple tar
            # without PAX hdrcharset warnings on GNU tar.
            info.pax_headers={}
            return info
        for path in sorted(out.iterdir()):tar.add(path,arcname=path.name,filter=normalize)
    checksum=sha(archive)
    archive.with_suffix(archive.suffix+'.sha256').write_text(checksum+'  '+archive.name+'\n')
    return archive, checksum

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--os', choices=['darwin','linux'], required=True)
    parser.add_argument('--arch', choices=['arm64','amd64'], required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--no-archive', action='store_true', help='Build a local qualification candidate only')
    parser.add_argument('--engine', type=pathlib.Path, required=True)
    parser.add_argument('--runtime-assets', type=pathlib.Path, required=True)
    parser.add_argument('--image', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if (args.os,args.arch) not in [('darwin','arm64'),('linux','amd64')]:parser.error('unqualified platform')
    verify_inputs(args)
    # The private extraction parent protects the bundle; payload modes are reproducible.
    os.umask(0o022)
    out = args.output.resolve();out.mkdir(parents=True, exist_ok=False)
    binaries = out/'bin';binaries.mkdir()
    env=os.environ|{'GOOS':args.os,'GOARCH':args.arch,'CGO_ENABLED':'0'}
    subprocess.run(['go','build','-trimpath','-o',str(out/'clankerbox'),'./cmd/clankerbox'],cwd=ROOT,env=env,check=True)
    for name in ['clankerbox-server','clankerbox-host']:
        subprocess.run(['go','build','-trimpath','-o',str(binaries/name),'./cmd/'+name],cwd=ROOT,env=env,check=True)
    subprocess.run(['go','build','-trimpath','-o',str(binaries/'clankerbox-guest'),'./cmd/clankerbox-guest'],cwd=ROOT,env=env|{'GOOS':'linux'},check=True)
    runtime=out/'runtime';runtime.mkdir()
    shutil.copy2(args.engine,runtime/'smolvm')
    shutil.copytree(args.runtime_assets/'lib',runtime/'lib',symlinks=True)
    for name in ['storage-template.ext4.zst','overlay-template.ext4.zst']:
        shutil.copy2(args.runtime_assets/name,runtime/name)
    shutil.copytree(args.image,out/'image',symlinks=True)
    licenses=out/'licenses';licenses.mkdir()
    source=ROOT/'.work/real-local-engine/source'
    for file in source.glob('LICENSE*'):shutil.copy2(file,licenses/('smolvm-'+file.name))
    shutil.copytree(ROOT/'scripts/release/licenses',licenses/'native')
    notices=ROOT/'.work/real-local-release/notices'
    if not notices.is_dir():raise RuntimeError('collect locked Go/Rust dependency notices before release assembly')
    shutil.copytree(notices,licenses/'dependencies')
    shutil.copy2(ROOT/'scripts/release/README.md',out/'RELEASE.md')
    shutil.copy2(ROOT/'spikes/real-local-engine/pins.json',out/'engine-pins.json')
    shutil.copy2(ROOT/'spikes/real-local-engine/runtime.patch',out/'runtime.patch')
    if args.os=='darwin':
        subprocess.run(['codesign','--verify','--strict',str(runtime/'smolvm')],check=True)
        subprocess.run(['codesign','--force','--sign','-',str(out/'clankerbox')],check=True)
        for name in ['clankerbox-server','clankerbox-host']:
            subprocess.run(['codesign','--force','--sign','-',str(binaries/name)],check=True)
    image_digest=content_digest(inventory(out/'image'))
    runtime_digest=content_digest(inventory(runtime)+[entry(out/'image/usr/local/bin/smolvm-agent','smolvm-agent')])
    manifest={'manifest_format':2,'version':args.version,'os':args.os,'arch':args.arch,
       'controller':'bin/clankerbox-server','host':'bin/clankerbox-host','guest':'bin/clankerbox-guest',
       'smolvm':'runtime/smolvm','library_dir':'runtime/lib','image_path':'image',
       'runtime_digest':runtime_digest,'image_digest':image_digest,
       'profile_id':'linux-dev-v3','profile_cpu':2,'profile_ram_mib':1024,'storage_gib':1,'overlay_gib':8,
       'files':inventory(out,include_root=False)}
    (out/'bundle.json').write_text(json.dumps(manifest,indent=2)+'\n')
    if args.no_archive:
        print(json.dumps({'manifest':str(out/'bundle.json'),'runtime_digest':runtime_digest,'image_digest':image_digest},indent=2));return
    archive, checksum = package_archive(out)
    print(json.dumps({'manifest':str(out/'bundle.json'),'archive':str(archive),'sha256':checksum,'runtime_digest':runtime_digest,'image_digest':image_digest},indent=2))
if __name__=='__main__':main()

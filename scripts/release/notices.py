#!/usr/bin/env python3
"""Collect dependency notices from the exact downloaded Go/Rust source trees."""
import argparse, json, pathlib, shutil, subprocess

def copy_notices(source,destination):
    files=[]
    for file in sorted([*source.glob('*'), *source.glob('*/*')]):
        if len(file.relative_to(source).parts)>2: continue
        if file.is_file() and file.name.upper().startswith(('LICENSE','COPYING','NOTICE','COPYRIGHT')):
            target=destination/file.relative_to(source)
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
            files.append(file.relative_to(source).as_posix())
    return files

def main():
    p=argparse.ArgumentParser();p.add_argument('--rust-metadata',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args()
    subprocess.run(['go','mod','download','all'],check=True)
    a.output.mkdir(parents=True,exist_ok=False)
    rows=[]
    for package in json.loads(a.rust_metadata.read_text())['packages']:
        key=package['name']+'-'+package['version'];source=pathlib.Path(package['manifest_path']).parent
        rows.append({'ecosystem':'rust','name':package['name'],'version':package['version'],'source':package.get('source'),'license':package.get('license'),'notices':copy_notices(source,a.output/'rust'/key)})
    raw=subprocess.check_output(['go','list','-m','-json','all'],text=True);decoder=json.JSONDecoder()
    while raw.strip():
        value,end=decoder.raw_decode(raw.lstrip());raw=raw.lstrip()[end:]
        if value.get('Main'):continue
        source=pathlib.Path(value['Dir']);key=value['Path'].replace('/','_')+'@'+value['Version']
        rows.append({'ecosystem':'go','name':value['Path'],'version':value['Version'],'notices':copy_notices(source,a.output/'go'/key)})
    (a.output/'dependencies.json').write_text(json.dumps(rows,indent=2)+'\n')
    print(json.dumps({'packages':len(rows),'without_top_level_notices':[r['name'] for r in rows if not r['notices']]}))
if __name__=='__main__':main()

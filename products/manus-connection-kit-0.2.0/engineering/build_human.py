"""Reproducible local frozen build. Run with isolated PyInstaller environment."""
from pathlib import Path
import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parent.parent
SOURCE=ROOT/'source'
TOOLING=ROOT/'engineering'/'human-tooling'
DIST=ROOT/'engineering'/'human-dist'

def hash_file(path):
    with path.open('rb') as file:return hashlib.file_digest(file,'sha256').hexdigest()

def main():
    global SOURCE
    attempt=int(sys.argv[1]) if len(sys.argv)>1 else 3
    snapshot=ROOT/'engineering'/('human-source-snapshot-A'+str(attempt))
    if snapshot.exists():raise SystemExit('Refusing to overwrite historical source snapshot; choose new attempt number.')
    shutil.copytree(SOURCE,snapshot,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    SOURCE=snapshot
    inventory={str(path.relative_to(SOURCE)).replace('\\','/'):hash_file(path)
               for path in SOURCE.rglob('*') if path.is_file() and '__pycache__' not in path.parts}
    embedded=TOOLING/'embedded';embedded.mkdir(parents=True,exist_ok=True)
    (embedded/'VERSION').write_text('0.2.0-human.1\n',encoding='utf-8')
    (embedded/'BUILD-MANIFEST.json').write_text(json.dumps({'version':'0.2.0-human.1','files':inventory,
        'self_hash_exclusion':'EXE is hashed externally after build; internal manifest inventories source inputs.'},indent=2),encoding='utf-8')
    (embedded/'MANIFEST.json').write_text(json.dumps({'schema':'mck-human-embedded-v1','version':'0.2.0-human.1',
        'files':[{'path':'internal/source/'+name,'sha256':digest} for name,digest in inventory.items()],
        'self_hash_exclusion':'MANIFEST and EXE external hash excluded to avoid recursive self-hash. Source snapshot bytes embedded exactly.',
        'runtime_core_version':'0.1.1','runtime':'Python 3.12 Windows x64 with Tk; notices under internal/runtime-notices',
        'update':'Explicit offline update; trusted external SHA256 required for replacing different binary; backup and pre/post selftests; rollback on failure.',
        'license_support':'UNRESOLVED','auth_live':'UNVERIFIED'},indent=2),encoding='utf-8')
    args=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onefile','--windowed',
          '--name','Manus-Connection-Kit-Setup','--distpath',str(DIST),'--workpath',str(TOOLING/'work'),
          '--specpath',str(TOOLING),'--paths',str(SOURCE/'src'),
          '--add-data',str(embedded)+';internal',
          '--add-data',str(SOURCE)+';internal/source',
          '--add-data',str(SOURCE/'HUMAN-GUIDE.md')+';internal',
          '--add-data',str(SOURCE/'tests'/'test_human.py')+';internal/tests',
          '--add-data',str(SOURCE/'config')+';internal/config',
          '--hidden-import','mcp_server',str(SOURCE/'bin'/'human-entry.py')]
    # License notices accompany the runtime, isolated tooling never enters consumer files.
    for filename in ('LICENSE.txt','LICENSE'):
        license_path=Path(sys.base_prefix)/filename
        if license_path.exists(): args[-1:-1]=['--add-data',str(license_path)+';internal/runtime-notices/python']
    for component in ('tcl8.6','tk8.6'):
        for name in ('license.terms','license.txt'):
            notice=Path(sys.base_prefix)/'tcl'/component/name
            if notice.exists():args[-1:-1]=['--add-data',str(notice)+';internal/runtime-notices/'+component]
    for notice in (Path(sys.prefix)/'Lib'/'site-packages'/'pyinstaller-6.16.0.dist-info'/'licenses').glob('*'):
        if notice.is_file():args[-1:-1]=['--add-data',str(notice)+';internal/runtime-notices/pyinstaller']
    result=subprocess.run(args,capture_output=True,text=True)
    (ROOT/'engineering'/'HUMAN-BUILD-LOG.txt').write_text(result.stdout+'\n'+result.stderr,encoding='utf-8')
    if result.returncode:raise SystemExit(result.returncode)
    output=DIST/'Manus-Connection-Kit-Setup.exe'
    data={'mission_id':'AGY-MCK-020-20261015','task_id':'HUMAN-BUILD','attempt':attempt,
          'idempotency_key':'AGY-MCK-020-20261015:HUMAN:'+str(attempt),'worker':'Work AI Master human-mode worker',
          'route':'LOCAL_WINDOWS_ISOLATED_PYINSTALLER','reason':'Owner-authorized self-contained Windows build',
          'status':'PACKAGE_BUILT','classification':'OBSERVED','version':'0.2.0-human.1',
          'artifact':str(output),'artifact_sha256':hash_file(output),'bytes':output.stat().st_size,
          'python':sys.version,'pyinstaller':importlib.metadata.version('pyinstaller'),
          'source_snapshot':str(snapshot),'first_pass':False,'retries':attempt-1,
          'blocker_class':'A1_LOCK_HANDLE_FIXED; FINAL_MANIFEST_AND_SNAPSHOT_ADDED',
          'build_inputs':inventory,'wheels':{p.name:hash_file(p) for p in (TOOLING/'wheels').glob('*.whl')},
          'tooling_source':'https://pypi.org/simple/ (HTTPS; locally SHA-256 inventoried, not publisher signatures)',
          'core_rewrite':False,'signing':'UNSIGNED','auth':'UNVERIFIED','live_execution':'UNVERIFIED',
          'visual_qa':'UNVERIFIED','commercial_license_support':'UNRESOLVED','cost_quota':'UNKNOWN',
          'callback_status':'LOCAL_RECEIPT_WRITTEN_AWAITING_PARENT_READBACK'}
    (ROOT/'engineering'/'HUMAN-BUILD.json').write_text(json.dumps(data,indent=2),encoding='utf-8')
    print(json.dumps({'status':'PACKAGE_BUILT','artifact':str(output),'sha256':data['artifact_sha256']}))

if __name__=='__main__':main()

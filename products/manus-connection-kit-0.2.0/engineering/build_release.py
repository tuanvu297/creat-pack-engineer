"""Select source, scan, manifest, archive, hash; preserve every build attempt."""
from pathlib import Path
import argparse,datetime,hashlib,json,shutil,sys,zipfile,subprocess
from scan import scan_items,tree
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'source'
def sha(data):return hashlib.sha256(data).hexdigest()
def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
def snapshot(root):return {n:b for n,b in tree(root) if '__pycache__' not in n and not n.endswith(('.pyc','.pyo'))}
def archive(root,target):
 with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for name,data in snapshot(root).items():
   info=zipfile.ZipInfo(name,(2026,10,15,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
   z.writestr(info,data)
 with zipfile.ZipFile(target) as z:assert z.testzip() is None
 return {'file':target.name,'sha256':sha(target.read_bytes()),'size':target.stat().st_size}
def manifest(root,mode):
 items=snapshot(root)
 value={'package_name':'manus-connection-kit-'+mode,'package_version':'0.2.0-'+mode+'.1','engine_version':'0.1.1',
 'purpose':'Verified per-user Manus connection onboarding; private evaluation candidate',
 'created_at':'2026-10-15T00:00:00+07:00','runtime_requirements':['Python>=3.10 standard library' if mode=='ai' else 'Bundled Windows x64 CPython/Tk runtime'],
 'dependencies':[],'entrypoints':['bin/kit-manager.py','bin/manus-kit.py'] if mode=='ai' else ['Manus-Connection-Kit-Setup.exe'],
 'input_contract':{'secret':'Own key through local owner boundary only','mutation':'Fresh controller grant and owner-scoped identity; no blind retry'},
 'output_contract':{'status':'Scoped JSON receipts or GUI PASS/BLOCKED','mcp':'Original JSON-lines stdio core'},
 'authentication_requirements':['Own MANUS_API_KEY; no key in package','Fresh owner-authorized signed host grant for mutations'],
 'known_limits':['Private evaluation; license/support UNRESOLVED','No ordinary web chat bridge','No publisher signature','Host Windows only; cross-OS UNVERIFIED','Inspect external QA receipt for fresh install/auth/live evidence'],
 'test_status':{k:'UNVERIFIED_SEE_EXTERNAL_RECEIPT' for k in ['PACKAGE_BUILT','INSTALL_TEST_PASS','LOCAL_FUNCTION_PASS','AUTH_VERIFIED','LIVE_EXECUTION_PASS','INTEGRATED_PASS']},
 'manifest_self_hash':'Excluded; covered by external archive SHA256',
 'files':[{'path':name,'sha256':sha(data),'size':len(data)} for name,data in items.items() if name!='MANIFEST.json']}
 write(root/'MANIFEST.json',value)
 return value
def build_ai(out):
 consumer=out/'consumer';kit=consumer/'kit';kit.mkdir(parents=True)
 human={'bin/human-entry.py','src/human_ui.py','src/windows_secret.py','tests/test_human.py','HUMAN-GUIDE.md'}
 for name,data in snapshot(SOURCE).items():
  if name in human or name=='MANIFEST.json':continue
  dest=kit/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
 (kit/'VERSION').write_text('0.2.0-ai.1\n',encoding='utf-8')
 config=json.loads((kit/'config'/'package.json').read_text(encoding='utf-8'))
 config.update(package_name='manus-connection-kit-ai',package_version='0.2.0-ai.1',engine_version='0.1.1',purpose='AI-assisted verified installation and explicit update around preserved Manus core',known_limits=['Private evaluation; license/support UNRESOLVED','No web chat bridge','No publisher signature; trusted external checksum required','No automatic update','No native always-on Work activation'],test_status={k:'UNVERIFIED_SEE_EXTERNAL_RECEIPT' for k in ['INSTALL_TEST_PASS','LOCAL_FUNCTION_PASS','AUTH_VERIFIED','LIVE_EXECUTION_PASS','INTEGRATED_PASS']})
 write(kit/'config'/'package.json',config)
 (consumer/'START-HERE.md').write_text('''# Manus Connection Kit — AI Mode 0.2.0-ai.1

Give this ZIP to a coding-capable AI and say: “Install this kit.”

AI: obtain the ZIP SHA-256 from the trusted release receipt, compare before
extracting/executing, then read kit/AI-INSTALL.md and follow its verify → install
→ offline self-test → generated MCP configuration → auth-readiness sequence.
Stop at a required owner key/account/OS permission boundary and report the exact
minimum action. Never ask for the key in chat or put it in a generated config.

Updates are explicit and require a trusted candidate checksum, backup and tests.
See kit/docs/UPDATE-ROLLBACK.md. Engine remains 0.1.1; onboarding is 0.2.0-ai.1.
This candidate requires filesystem/terminal access and Python 3.10+. Ordinary
web chat has no proven local bridge. License/support UNRESOLVED; private pilot.
''',encoding='utf-8')
 mf=manifest(kit,'ai')
 scan=scan_items(tree(consumer));write(out/'SECRET-SCAN.json',scan)
 if scan['findings']:raise RuntimeError('SECRET_SCAN_REVIEW_REQUIRED')
 r=archive(consumer,out/'manus-connection-kit-0.2.0-ai.1.zip')
 receipt={'mission_id':'AGY-MCK-020-20261015','mode':'ai','build_attempt':out.name,'classification':'OBSERVED','artifact':r,'manifest_files':len(mf['files']),
 'PACKAGE_BUILT':'PASS','INSTALL_TEST_PASS':'UNVERIFIED','LOCAL_FUNCTION_PASS':'UNVERIFIED','AUTH_VERIFIED':'UNVERIFIED','LIVE_EXECUTION_PASS':'UNVERIFIED','INTEGRATED_PASS':'UNVERIFIED',
 'commercial_ready':'BLOCKED_LICENSE_SUPPORT_UNRESOLVED','publisher_signature':'UNAVAILABLE','manifest_self_hash_excluded':True}
 write(out/'BUILD-RECEIPT.json',receipt)
 (out/'SHA256SUMS.txt').write_text(r['sha256']+'  '+r['file']+'\n',encoding='utf-8')
 return receipt
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--attempt',required=True);args=p.parse_args()
 out=ROOT/'release'/args.attempt
 if out.exists():raise SystemExit('ATTEMPT_EXISTS_USE_NEW_ID')
 out.mkdir(parents=True)
 print(json.dumps(build_ai(out)))

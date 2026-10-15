"""Independent QA; outputs/fixtures only under qa; no real credentials/providers."""
import hashlib, json, os, pathlib, shutil, stat, subprocess, sys, tempfile, zipfile
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]; QA=ROOT/'qa'
PYTHON=sys.executable
results=[]
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def check(name,fn):
 try:
  detail=fn();results.append({'test_id':name,'status':'PASS','classification':'OBSERVED','detail':detail})
 except Exception as e:
  results.append({'test_id':name,'status':'FAIL','classification':'OBSERVED','error':type(e).__name__,'detail':str(e)})
def require(value,msg):
 if not value:raise AssertionError(msg)
def blocked(fn,expected):
 try:fn()
 except Exception as e:
  require(expected in str(e),repr(e));return str(e)
 raise AssertionError('Expected block '+expected)
def repack(package,archive):
 manifest=json.loads((package/'MANIFEST.json').read_text(encoding='utf-8-sig'))
 manifest['files']=[{'path':p.relative_to(package).as_posix(),'sha256':sha(p)} for p in sorted(package.rglob('*')) if p.is_file() and p.name!='MANIFEST.json']
 (package/'MANIFEST.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
 with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('START-HERE.md','Independent QA synthetic update fixture only')
  for p in package.rglob('*'):
   if p.is_file():z.write(p,'kit/'+p.relative_to(package).as_posix())
 return sha(archive)
def run(archive):
 archive=pathlib.Path(archive);fingerprint=sha(archive)
 with tempfile.TemporaryDirectory(dir=QA,prefix='ai-clean-') as temp:
  temp=pathlib.Path(temp);package=temp/'extracted';package.mkdir()
  # Independent preflight central directory validation before any extraction.
  with zipfile.ZipFile(archive) as z:
   require(z.testzip() is None,'Archive CRC failure')
   for i in z.infolist():
    require(not i.filename.startswith(('/', '\\')) and '..' not in pathlib.PurePosixPath(i.filename).parts,'Archive unsafe path')
   z.extractall(package)
  package=package/'kit';sys.path.insert(0,str(package/'src'));import kit_install as manager
  check('AI-Q01-exact-manifest',lambda: {k:v for k,v in manager.verify_package(package).items() if k!='manifest'})
  def core():
   baseline=json.loads((ROOT/'engineering'/'BASELINE-INSPECT.json').read_text())['core_comparison']
   for row in baseline:require(sha(package/row['path'])==row['sha256'],'Canonical changed '+row['path'])
   return baseline
  check('AI-Q02-baseline-byte-identical',core)
  install=temp/'isolated install';check('AI-Q03-clean-install',lambda:manager.install(package,install,PYTHON))
  check('AI-Q04-self-test',lambda:manager.self_test(install/'current',PYTHON))
  check('AI-Q05-no-key-auth-readiness',lambda:manager.auth_readiness())
  def mcp():
   config=manager.generate_mcp(install);server=config['mcpServers']['manus-kit']
   env=os.environ.copy();env['MANUS_API_KEY']='INDEPENDENT_QA_SYNTHETIC_NEVER_NETWORK';env.pop('MANUS_KIT_GRANT_FILE',None)
   messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','clientInfo':{'name':'fresh-independent-qa','version':'1'}}},{'jsonrpc':'2.0','method':'notifications/initialized'},{'jsonrpc':'2.0','id':2,'method':'tools/list'},{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'manus_journal_status','arguments':{}}},{'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'manus_task_create','arguments':{'prompt':'QA must be blocked before any transport'}}}]
   p=subprocess.run([server['command'],*server['args']],input=''.join(json.dumps(x)+'\n' for x in messages),capture_output=True,text=True,env=env,timeout=30)
   require(p.returncode==0,p.stderr);outputs=[json.loads(x) for x in p.stdout.splitlines()]
   require(outputs[0]['result']['serverInfo']['name']=='manus_connection_kit','Handshake failed')
   require(len(outputs[1]['result']['tools'])==8,'Missing tools')
   require(outputs[2]['result']['structuredContent']['network_requests']==0,'Network in journal')
   require(outputs[3]['result']['isError'] and 'CONTROLLER_GRANT_FILE_REQUIRED' in outputs[3]['result']['content'][0]['text'],'No-grant create not blocked')
   return {'generated_config':config,'responses':outputs,'provider_requests':0,'transport':'real child stdio process'}
  check('AI-Q06-generated-MCP-child-handshake',mcp)
  check('AI-Q07-wrong-archive-hash',lambda:blocked(lambda:manager.update(archive,'0'*64,install),'ARCHIVE_HASH_MISMATCH'))
  def extra():
   bad=temp/'extra';shutil.copytree(package,bad);(bad/'extra.txt').write_text('not declared')
   return blocked(lambda:manager.verify_package(bad),'UNDECLARED_FILE')
  check('AI-Q08-extra-file-rejected',extra)
  def malicious():
   for idx,name in enumerate(['../escape.txt','C:/escape.txt','kit/CON.txt','kit/a/../b','kit/a\\b']):
    z=temp/('bad%d.zip'%idx)
    with zipfile.ZipFile(z,'w') as f:f.writestr(name,'synthetic')
    destination=temp/('dest%d'%idx);destination.mkdir()
    blocked(lambda:manager.extract_verified_zip(z,sha(z),destination),'UNSAFE_PATH')
   return {'malformed_archives_rejected':5}
  check('AI-Q09-unsafe-archive-paths',malicious)
  base=manager.verify_package(install/'current')['version']
  version=base.rsplit('.',1)[0]+'.99'
  def failing():
   bad=temp/'failing';shutil.copytree(package,bad)
   (bad/'tests'/'test_independent_failure.py').write_text('import unittest\nclass Reject(unittest.TestCase):\n def test_reject(self):self.fail("QA intentional candidate failure")\n')
   m=json.loads((bad/'MANIFEST.json').read_text());m['package_version']=version;(bad/'MANIFEST.json').write_text(json.dumps(m))
   z=temp/'failing.zip';digest=repack(bad,z)
   reason=blocked(lambda:manager.update(z,digest,install),'OFFLINE_TEST_FAILED')
   require(manager.verify_package(install/'current')['version']==base,'Failed update replaced version')
   return {'block':reason,'previous_version_preserved':base}
  check('AI-Q10-update-self-test-failure-preserves-current',failing)
  def success():
   candidate=temp/'newer';shutil.copytree(package,candidate)
   m=json.loads((candidate/'MANIFEST.json').read_text());m['package_version']=version;(candidate/'MANIFEST.json').write_text(json.dumps(m));(candidate/'VERSION').write_text(version+'\n')
   z=temp/'newer.zip';digest=repack(candidate,z)
   updated=manager.update(z,digest,install);require(updated['version']==version,'Update version wrong')
   restored=manager.rollback(install,updated['backup_id']);require(restored['version']==base,'Rollback version wrong')
   return {'updated':version,'rolled_back':base,'backup_id':updated['backup_id'],'self_tests':'pre/post activation'}
  check('AI-Q11-update-backup-and-explicit-rollback',success)
  def uninstall():
   marker=install/'state'/'qa-private-preservation.txt';marker.write_text('synthetic state')
   result=manager.uninstall(install);require(marker.exists(),'Private state removed');require(not (install/'current').exists(),'App not removed');return result
  check('AI-Q12-uninstall-preserves-state',uninstall)
 out={'mission_id':'AGY-MCK-020-20261015','task_id':'INDEPENDENT-QA','attempt':1,'idempotency_key':'AGY-MCK-020-20261015:QA:1','QA_CONTRACT_VERSION':'1.1','artifact':str(archive),'sha256':fingerprint,'worker':'independent_qa','route':'native collaboration Work scoped worker','tests':results,'live_requests':0,'real_keys_read':False,'limitations':['No actual host MCP import; child protocol evidence only','No auth/live action without fresh owner grant','No GUI/human usability claim']}
 (QA/'AI-TEST-EVIDENCE-A1.json').write_text(json.dumps(out,indent=2),encoding='utf-8');print(json.dumps(out,indent=2))
if __name__=='__main__':run(sys.argv[1])

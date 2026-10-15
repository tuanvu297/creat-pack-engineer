"""Human independent tests; local synthetic state only; no GUI usability claim."""
import json, pathlib,sys,tempfile,subprocess,hashlib,os,shutil
from unittest.mock import patch
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1];QA=ROOT/'qa'
sys.path.insert(0,str(ROOT/'source'/'src'))
import human_ui as human
from windows_secret import SecretStore,SecretError
from manus_kit import Api
results=[]
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def require(v,m):
 if not v:raise AssertionError(m)
def check(name,fn):
 try:results.append({'test_id':name,'status':'PASS','classification':'OBSERVED','detail':fn()})
 except Exception as e:results.append({'test_id':name,'status':'FAIL','classification':'OBSERVED','error':type(e).__name__,'detail':str(e)})
def blocked(fn,expected):
 try:fn()
 except Exception as e:
  require(expected in str(e),str(e));return str(e)
 raise AssertionError('Expected '+expected)
def run(exe):
 exe=pathlib.Path(exe);fingerprint=sha(exe)
 with tempfile.TemporaryDirectory(dir=QA,prefix='human-independent-') as temp:
  temp=pathlib.Path(temp);state=temp/'state';install=temp/'installed';
  env={k:v for k,v in os.environ.items() if k not in ('MANUS_API_KEY','MANUS_KIT_GRANT_FILE','PYTHONPATH','PYTHONHOME')}
  env['PATH']=os.path.join(os.environ['SystemRoot'],'System32')
  def call(extra,filename='result.json'):
   report=temp/filename;report.unlink(missing_ok=True)
   p=subprocess.run([str(exe),*extra,'--result-file',str(report)],capture_output=True,env=env,timeout=90)
   require(report.exists(),f'No result file; exit={p.returncode} stderr={p.stderr!r}')
   result=json.loads(report.read_text());require(p.returncode==0 and result['status']=='PASS',str(result));return result
  check('H-Q01-frozen-offline-selftest-without-Python-PATH',lambda:call(['--self-test']))
  check('H-Q02-frozen-isolated-install',lambda:call(['--install-headless','--install-root',str(install),'--expected-sha256',fingerprint]))
  check('H-Q03-installed-binary-hash',lambda:require(sha(install/'current'/human.APP)==fingerprint,'Copy changed') or {'sha256':fingerprint})
  check('H-Q04-missing-key-Test-Connection',lambda:human.test_connection(state))
  def secret():
   store=SecretStore(state);store.save('INDEPENDENT_SYNTHETIC_KEY_ONLY')
   require(store.load()=='INDEPENDENT_SYNTHETIC_KEY_ONLY','DPAPI mismatch');require(b'INDEPENDENT_SYNTHETIC_KEY_ONLY' not in store.path.read_bytes(),'Plaintext persisted')
   return {'DPAPI':'Windows CurrentUser encrypted roundtrip','plaintext_absent':True}
  check('H-Q05-DPAPI-synthetic-boundary',secret)
  def injected():
   calls=[]
   def transport(endpoint,params,body):calls.append(endpoint);return {'ok':True,'user_id':'synthetic','request_id':'synthetic'}
   result=human.test_connection(state,api_factory=lambda key:Api(key,transport=transport));require(result['status']=='PASS' and calls==['user.me'],'Auth handler boundary failed')
   def error(key):raise ValueError('INDEPENDENT_SYNTHETIC_KEY_ONLY')
   denied=human.test_connection(state,api_factory=error);require('INDEPENDENT_SYNTHETIC_KEY_ONLY' not in json.dumps(denied),'Key leak')
   return {'test_connection':result,'fake_transport_calls':calls,'provider_calls':0,'exception_redacted':denied}
  check('H-Q06-Test-Connection-injected-only-readonly-and-no-key-error-leak',injected)
  def mcp():
   config=human.mcp_config(install,state);server=config['mcpServers']['manus'];
   require('env' not in server,'Secret config')
   messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','clientInfo':{'name':'independent-human-qa','version':'1'}}},{'jsonrpc':'2.0','method':'notifications/initialized'},{'jsonrpc':'2.0','id':2,'method':'tools/list'},{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'manus_journal_status','arguments':{}}},{'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'manus_task_create','arguments':{'prompt':'Must block without grant'}}}]
   p=subprocess.run([server['command'],*server['args']],input=''.join(json.dumps(x)+'\n' for x in messages),capture_output=True,text=True,env=env,timeout=60)
   require(p.returncode==0,f'MCP process rc={p.returncode} stderr={p.stderr}')
   out=[json.loads(x) for x in p.stdout.splitlines()];require(len(out)==4,'MCP missing responses');require(len(out[1]['result']['tools'])==8,'MCP tools');require(out[2]['result']['structuredContent']['network_requests']==0,'Unexpected network');require(out[3]['result']['isError'],'Grant bypass')
   return {'transport':'actual frozen installed EXE stdio child','config':config,'responses':out,'provider_calls':0}
  check('H-Q07-frozen-MCP-child',mcp)
  def corruption():
   store=SecretStore(state);store.path.write_bytes(b'corrupt DPAPI fixture');require(human.test_connection(state)['reason']=='KEY_DECRYPT_FAILED','Corrupt key not blocked');store.remove();return {'reason':'KEY_DECRYPT_FAILED','synthetic_key_removed':True}
  check('H-Q08-corrupt-key-failclosed',corruption)
  def source_update():
   root=temp/'fixture-install';a=temp/'first.exe';b=temp/'second.exe';a.write_bytes(b'fixture-a');b.write_bytes(b'fixture-b');human.install_exe(a,root)
   blocked(lambda:human.install_exe(b,root),'TRUSTED_UPDATE_CHECKSUM_REQUIRED')
   with patch('human_ui.probe_exe',side_effect=[None,ValueError('QA_POST_SWITCH_FAIL')]):blocked(lambda:human.install_exe(b,root,verify=sha(b)),'QA_POST_SWITCH_FAIL')
   require(sha(root/'current'/human.APP)==sha(a),'Failed activation changed current')
   human.install_exe(b,root,verify=sha(b));m=json.loads((root/human.MARKER).read_text());backup=root/m['previous'];saved=backup.read_bytes();backup.write_bytes(b'tampered');blocked(lambda:human.rollback_exe(root),'BACKUP_CHECKSUM_MISMATCH');backup.write_bytes(saved)
   human.rollback_exe(root);require(sha(root/'current'/human.APP)==sha(a),'Rollback wrong')
   return {'source_fixture_tests':'explicit checksum, failed post-switch restore, backup tamper denial, successful rollback','real_update_version':'UNVERIFIED: only one real executable available'}
  check('H-Q09-update-and-rollback-negative-source-fixtures',source_update)
  def uninstall():
   marker=state/'retain-private-state';marker.write_text('synthetic')
   result=call(['--maintenance-worker','uninstall','--install-root',str(install)],'uninstall.json');require(marker.exists(),'Private state erased');require(not (install/'current'/human.APP).exists(),'EXE retained');return result
  check('H-Q10-frozen-uninstall-preserves-private-state',uninstall)
 out={'mission_id':'AGY-MCK-020-20261015','task_id':'INDEPENDENT-QA','QA_CONTRACT_VERSION':'1.1','attempt':3,'idempotency_key':'AGY-MCK-020-20261015:QA:3:HUMAN','exe':str(exe),'exe_sha256':fingerprint,'tests':results,'live_provider_calls':0,'real_keys_read':False,'GUI_visual':'UNVERIFIED','nontechnical_user_usability':'UNVERIFIED','host_client_import':'UNVERIFIED'}
 (QA/'HUMAN-TEST-EVIDENCE-A3.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
if __name__=='__main__':run(sys.argv[1])

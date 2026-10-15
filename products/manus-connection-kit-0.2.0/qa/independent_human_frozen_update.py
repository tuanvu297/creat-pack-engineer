import pathlib,hashlib,json,subprocess,os,tempfile
ROOT=pathlib.Path('D:/Codex/manus-connection-kit-upgrade-20261015');QA=ROOT/'qa';new=ROOT/'engineering'/'human-dist'/'Manus-Connection-Kit-Setup.exe';old=ROOT/'engineering'/'human-tooling'/'previous-candidate.exe'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(new)=='f49812ecade1231b1003ac135532f68e90db61a9f85df0769110e150ed0815a6';assert sha(old)=='f92751002719f36b56ecff23fce2eff98bb96e0156f2db3b3429c5896998ec49'
env={k:v for k,v in os.environ.items() if k not in ('MANUS_API_KEY','MANUS_KIT_GRANT_FILE','PYTHONPATH','PYTHONHOME')};env['PATH']=str(pathlib.Path(os.environ['SystemRoot'])/'System32')
with tempfile.TemporaryDirectory(dir=QA,prefix='human-frozen-update-') as temp:
 t=pathlib.Path(temp);root=t/'install';state=t/'state';observed=[]
 def call(exe,args,label,expect='PASS'):
  result=t/(label+'.json');p=subprocess.run([str(exe),*args,'--install-root',str(root),'--state',str(state),'--result-file',str(result)],capture_output=True,env=env,timeout=90);r=json.loads(result.read_text());assert r['status']==expect,(label,r);assert (p.returncode==0)==(expect=='PASS');observed.append({'test':label,'result':r});return r
 call(old,['--install-headless','--expected-sha256',sha(old)],'install-prior-dev-fixture');installed=root/'current'/'ManusConnectionKit.exe';assert sha(installed)==sha(old)
 call(new,['--install-headless','--expected-sha256','0'*64],'bad-checksum-update',expect='BLOCKED');assert sha(installed)==sha(old)
 call(new,['--install-headless','--expected-sha256',sha(new)],'actual-frozen-update');assert sha(installed)==sha(new)
 marker=json.loads((root/'mck-human-install.json').read_text());backup=root/marker['previous'];saved=backup.read_bytes();backup.write_bytes(b'corrupt backup QA fixture')
 call(new,['--maintenance-worker','rollback'],'tampered-backup-blocked',expect='BLOCKED');assert sha(installed)==sha(new);backup.write_bytes(saved)
 call(new,['--maintenance-worker','rollback'],'actual-frozen-rollback');assert sha(installed)==sha(old)
 call(new,['--maintenance-worker','uninstall'],'uninstall-after-rollback')
 out={'status':'PASS','classification':'OBSERVED','final_exe_sha256':sha(new),'previous_dev_fixture_sha256':sha(old),'prior_fixture_note':'A1 internal development candidate, not a published older version','observations':observed,'live_network_requests':0,'private_data_used':False,'GUI_click_route':'UNVERIFIED: maintenance worker invoked directly, no visible GUI claim'};(QA/'HUMAN-FROZEN-UPDATE-ROLLBACK-A3.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))

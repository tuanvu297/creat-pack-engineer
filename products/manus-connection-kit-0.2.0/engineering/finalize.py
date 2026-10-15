"""Scope final candidate receipts; source/evidence remain separate from consumer."""
from pathlib import Path
import argparse,hashlib,json,sys,zipfile,datetime
from build_release import ROOT,write,archive
from scan import scan_items,tree
def load(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(b):return hashlib.sha256(b).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--ai-attempt',default='AI-A3');p.add_argument('--human-attempt',required=True);p.add_argument('--ai-qa',required=True);p.add_argument('--human-qa',required=True);p.add_argument('--attempt',required=True);a=p.parse_args()
 out=ROOT/'release'/a.attempt
 if out.exists():raise SystemExit('PRESERVE_OLD_ATTEMPT')
 out.mkdir()
 live=load(ROOT/'engineering'/'LIVE-RESULT.json') if (ROOT/'engineering'/'LIVE-RESULT.json').exists() else {}
 receipts={}
 for mode,build_id,qa_name in [('ai',a.ai_attempt,a.ai_qa),('human',a.human_attempt,a.human_qa)]:
  build=load(ROOT/'release'/build_id/'BUILD-RECEIPT.json');qa=load(ROOT/'qa'/qa_name)
  artifact=ROOT/'release'/build_id/build['artifact']['file']
  assert sha(artifact.read_bytes())==build['artifact']['sha256']
  qa_text=json.dumps(qa)
  assert build['artifact']['sha256'] in qa_text,'QA_HASH_BINDING_REQUIRED'
  receipt={**build,'QA_CONTRACT_VERSION':'1.1','classification':'OBSERVED','QA_report':'qa/'+qa_name,'QA_report_sha256':sha((ROOT/'qa'/qa_name).read_bytes()),'updated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
   'status':'PRIVATE_EVALUATION_CANDIDATE_SCOPED_TECHNICAL_QA','pass_ladder':qa.get('pass_ladder',qa.get('levels',{})),
   'commercial_ready':'BLOCKED_LICENSE_SUPPORT_UNRESOLVED','nontechnical_usability':'UNVERIFIED_REAL_PARTICIPANT_REQUIRED' if mode=='human' else 'NOT_APPLICABLE',
   'AUTH_VERIFIED':live.get('AUTH_VERIFIED','UNVERIFIED') if mode=='ai' else 'BLOCKED_LOCAL_CUSTOMER_KEY_BOUNDARY',
   'LIVE_EXECUTION_PASS':live.get('LIVE_EXECUTION_PASS','UNVERIFIED') if mode=='ai' else 'NOT_RUN_READONLY_TEST_CONNECTION_PRODUCT',
   'INTEGRATED_PASS':'UNVERIFIED_DISTINCT_AGY_RECEIVING_SYSTEM_NOT_TESTED','source_core':'Byte-identical to canonical0.1.1-A2; see BASELINE-INSPECT.json',
   'checkpoint':{'github_source_commit':'d6ee0744ea01573bf7bb7bf4a7b59e20b7141be4','github_mission_readback':'EXACT_CONTENT_MATCH','drive_mission_id':'1fM70ejbpeHZDfYS_yZBkkt-kWZf7Z2fB','drive_mission_metadata_readback':'VERIFIED','final_artifact_readbacks':'See separate SYNC-RECEIPT.json'},
   'minimum_owner_action':['Enter your own key locally and click Test Connection; nontechnical participant confirms visible flow','Resolve license/support and signing before commercial release'] if mode=='human' else ['Import generated local MCP configuration into chosen client if desired; client-specific ingestion unverified'],
   'known_limits':['Current Windows workstation only; clean VM/other OS unverified','No ordinary web-chat bridge','No always-on/autonomous AGY dispatch claim','Unsigned publisher metadata','Finite secret-scan coverage']}
  if mode=='ai':
   receipt['pass_ladder'].update(AUTH_VERIFIED=receipt['AUTH_VERIFIED'],LIVE_EXECUTION_PASS=receipt['LIVE_EXECUTION_PASS'],INTEGRATED_PASS=receipt['INTEGRATED_PASS'])
   receipt['live_independent_readback']='qa/AI-LIVE-INDEPENDENT-READBACK-A3.json'
  receipts[mode]=receipt;write(out/(mode.upper()+'-RELEASE-RECEIPT.json'),receipt)
  # Bundle immutable evidence and reproducible source; never glob private state.
  stage=out/(mode+'-evidence');stage.mkdir()
  selected=[]
  selected += [p for p in (ROOT/'engineering').iterdir() if p.is_file() and p.suffix in {'.json','.jsonl','.md','.py','.txt'} and p.name not in {'HUMAN-BUILD-LOG.txt'}]
  selected += [p for p in (ROOT/'qa').iterdir() if p.is_file() and p.suffix in {'.json','.md','.py'}]
  for file in selected:
   rel=file.relative_to(ROOT);dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(file.read_bytes())
  source=ROOT/'release'/a.ai_attempt/'consumer'/'kit' if mode=='ai' else ROOT/'engineering'/'human-source-snapshot-A3'
  if not source.exists():raise SystemExit('EXACT_HUMAN_BUILD_SOURCE_SNAPSHOT_REQUIRED')
  for name,data in tree(source):
   if '__pycache__' in name or name.endswith(('.pyc','.pyo')):continue
   dest=stage/'source'/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
  write(stage/'RELEASE-RECEIPT.json',receipt)
  write(stage/'EVIDENCE-INDEX.json',{'mission_id':'AGY-MCK-020-20261015','mode':mode,'consumer_sha256':build['artifact']['sha256'],'inventory':[{'path':n,'sha256':sha(b)} for n,b in tree(stage)],'self_exclusions':['EVIDENCE-INDEX.json','MANIFEST.json','SECRET-SCAN.json'],'live_grants_and_journals':'EXCLUDED','canonical_AGY_corpus':'EXCLUDED_IDS_ONLY','old_FAIL_evidence':'Preserved append-only; final QA supersedes disposition only'})
  scan=scan_items(tree(stage));write(stage/'SECRET-SCAN.json',scan)
  if scan['findings']:raise SystemExit('EVIDENCE_SECRET_REVIEW_REQUIRED:'+json.dumps(scan['findings']))
  write(stage/'MANIFEST.json',{'package_name':'mck-'+mode+'-engineering-evidence','package_version':'0.2.0-'+mode+'.1','files':[{'path':n,'sha256':sha(b),'size':len(b)} for n,b in tree(stage)],'self_hash_excluded':True,'outer_hash_covers_manifest':True})
  r=archive(stage,out/('manus-connection-kit-0.2.0-'+mode+'.1-evidence.zip'));write(out/(mode.upper()+'-EVIDENCE-RECEIPT.json'),r)
 checks=[]
 for mode,receipt in receipts.items():checks.append(receipt['artifact']['sha256']+'  '+receipt['artifact']['file'])
 for pth in out.glob('*-evidence.zip'):checks.append(sha(pth.read_bytes())+'  '+pth.name)
 (out/'SHA256SUMS.txt').write_text('\n'.join(checks)+'\n',encoding='utf-8')
 print(json.dumps({'status':'EVIDENCE_BUNDLES_CREATED','out':str(out),'consumer_artifacts':[r['artifact'] for r in receipts.values()]}))
if __name__=='__main__':main()

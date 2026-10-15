"""Independent read-only verification of current fresh mission task. Never submit."""
import pathlib,sys,json,hashlib,datetime
sys.dont_write_bytecode=True
ROOT=pathlib.Path('D:/Codex/manus-connection-kit-upgrade-20261015');sys.path.insert(0,str(ROOT/'live-ai-install'/'current'/'src'))
from kit_install import verify_package
from manus_kit import Journal,Api,Adapter,load_key,strict_load
check=verify_package(ROOT/'live-ai-install'/'current');assert check['version']=='0.2.0-ai.1'
receipt=json.loads((ROOT/'engineering'/'LIVE-RESULT.json').read_text());assert receipt['archive_sha256']=='9dfd29c46063be497ec099e39264ed6b27457f59f410c1e26c6c7284901060ad'
grant=strict_load((ROOT/'private-live'/'current-grant.json').read_bytes());assert grant['body']['issued_at']==receipt['grant_issued_at']
journal=Journal(ROOT/'private-live'/'state')
try:
 before=journal.db.execute('SELECT COUNT(*) FROM intents').fetchone()[0]
 result=Adapter(journal,Api(load_key())).read(grant,reconcile=True)
 after=journal.db.execute('SELECT COUNT(*) FROM intents').fetchone()[0]
 summary=result['result'];parsed=json.loads(summary['text']);assert parsed['nonce']==receipt['nonce'] and type(parsed['sum']) is int and parsed['sum']==43
 assert result['provider_task_id']==receipt['provider_task_id'];assert summary['closure']=='STOPPED_WITH_REPLY';assert summary['background_jobs'] is False and result['messages']['has_more'] is False
 assert before==after==1
 out={'mission_id':'AGY-MCK-020-20261015','task_id':'INDEPENDENT-LIVE-READBACK','attempt':1,'idempotency_key':'AGY-MCK-020-20261015:QA:LIVE:READ:1','QA_CONTRACT_VERSION':'1.1','status':'PASS','classification':'OBSERVED','archive_sha256':receipt['archive_sha256'],'provider_task_id':result['provider_task_id'],'parsed_result':{'nonce':parsed['nonce'],'sum':parsed['sum']},'closure':summary['closure'],'provider_status':summary['provider_status'],'background_jobs':summary['background_jobs'],'has_more':result['messages']['has_more'],'pages':result['pages'],'journal_intents_before':before,'journal_intents_after':after,'mutations_by_QA':0,'auth_scope':'Successful real provider read using current authorized binding; no separate auth call by QA','LIVE_EXECUTION_PASS':'PASS_INDEPENDENT_RESULT_READBACK','INTEGRATED_PASS':'UNVERIFIED_REQUIRES_DISTINCT_RECEIVING_SYSTEM','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 (ROOT/'qa'/'AI-LIVE-INDEPENDENT-READBACK-A3.json').write_text(json.dumps(out,indent=2),encoding='utf-8');print(json.dumps(out,indent=2))
finally:journal.close()

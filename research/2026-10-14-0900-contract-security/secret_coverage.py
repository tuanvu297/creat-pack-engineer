"""Generated, non-live OAuth field fixtures; values are never printed."""
from pathlib import Path
from datetime import datetime,timezone,timedelta
import hashlib,importlib.util,json,sys
sys.dont_write_bytecode=True
source=Path('D:/Codex/ai-release-engineer/src/release_engineer.py')
spec=importlib.util.spec_from_file_location('coverage_subject',source)
tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)
generated=''.join(chr(65+(i%26)) for i in range(32))
rows=[]
for label,key,value in [('generic_secret','secret',generated),
                        ('oauth_client_secret','client_secret',generated),
                        ('known_placeholder','client_secret','REPLACE_WITH_SECRET')]:
    hits=tool.screen('config/example.json',json.dumps({key:value}).encode())
    rows.append({'case':label,'synthetic_only':True,'current_signature_scan_detected':bool(hits),
      'findings_without_values':hits,'expected_suspicious_content':label!='known_placeholder'})
assert rows[0]['current_signature_scan_detected']
assert not rows[1]['current_signature_scan_detected']
assert not rows[2]['current_signature_scan_detected']
result={'task_id':'CREAT-PACK-LEARNING-20261014-0900',
 'recorded_at':datetime.now(timezone(timedelta(hours=7))).isoformat(),
 'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
 'status':'COVERAGE_GAP_REPRODUCED', 'cases':rows,
 'scope':'Synthetic field-name coverage only; no real credential, no remote scanner/API',
 'proposal':'Add context-aware client_secret detection with placeholder allowlist; validate false positives before adoption.',
 'not_claimed':['Full OAuth/provider token detection','Any actual secret leak','GitHub push protection enabled on this private repository','Production scanner fix']}
(Path(__file__).parent/'SECRET-COVERAGE.json').write_bytes((json.dumps(result,indent=2,allow_nan=False)+'\n').encode())
print(json.dumps(result))

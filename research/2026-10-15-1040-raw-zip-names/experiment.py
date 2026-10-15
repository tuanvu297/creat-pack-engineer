"""Read-only synthetic ZIP checks; never extracts or executes member bytes."""
import hashlib,io,json,sys,tempfile,zipfile
from datetime import datetime,timezone
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('D:/Codex/ai-release-engineer')
sys.path.insert(0,str(ROOT/'src'));import release_engineer as release
def sha(data):return hashlib.sha256(data).hexdigest()
def witness(logical,stored,raw):
 data=b'synthetic inert fixture only\n'
 manifest={'package_name':'fixture','package_version':'0.0.0','purpose':'Offline research synthetic negative-control fixture','created_at':'2026-10-15T00:00:00Z','runtime_requirements':[],'dependencies':[],'entrypoints':[logical],'input_contract':{},'output_contract':{},'known_limits':['Not a released runtime'],'authentication_requirements':[],'test_status':{},'files':[{'path':logical,'sha256':sha(data),'size':len(data)}]}
 buffer=io.BytesIO()
 with zipfile.ZipFile(buffer,'w',zipfile.ZIP_STORED)as archive:
  archive.writestr(stored,data);archive.writestr('fixture/MANIFEST.json',json.dumps(manifest))
 contents=buffer.getvalue()
 if stored!=raw:
  assert len(stored.encode())==len(raw.encode())
  assert contents.count(stored.encode())==2
  contents=contents.replace(stored.encode(),raw.encode())
 return contents
def candidate_guard(path):
 with zipfile.ZipFile(path)as archive:
  for info in archive.infolist():
   original=getattr(info,'orig_filename',None)
   if not isinstance(original,str)or original!=info.filename:raise ValueError('RAW_FILENAME_NOT_PRESERVED')
   release.safe_name(original[:-1]if info.is_dir()else original)
 return release.verify_zip(path)
def outcome(fn,path):
 try:r=fn(path);return {'accepted':True,'PACKAGE_BUILT':r.get('PACKAGE_BUILT')}
 except Exception as e:return {'accepted':False,'error_type':type(e).__name__,'reason':str(e)[:160]}
cases=[('valid_ascii','a.txt','fixture/a.txt','fixture/a.txt',True),('valid_unicode','xin-chao-\u0111.txt','fixture/xin-chao-\u0111.txt','fixture/xin-chao-\u0111.txt',True),('nul_suffix','a','fixture/aQignored','fixture/a\0ignored',False),('backslash_separator','sub/a.txt','fixture/sub/a.txt','fixture\\sub\\a.txt',False)]
results=[]
with tempfile.TemporaryDirectory(prefix='creatpack-zip-research-')as temp:
 for name,logical,stored,raw,expected in cases:
  contents=witness(logical,stored,raw);p=Path(temp)/(name+'.zip');p.write_bytes(contents)
  with zipfile.ZipFile(p)as archive:
   info=archive.infolist()[0];observed={'original_repr':repr(info.orig_filename),'normalized_repr':repr(info.filename),'name_changed':info.orig_filename!=info.filename}
  before=outcome(release.verify_zip,p);after=outcome(candidate_guard,p)
  results.append({'case':name,'expected_accept':expected,'fixture_sha256':sha(contents),'metadata':observed,'current':before,'candidate':after})
 report={'task_id':'CREAT-PACK-LEARNING-20261015-1040','observed_at':datetime.now(timezone.utc).isoformat(),'classification':'OBSERVED_LOCAL_SYNTHETIC_EXPERIMENT','runtime':{'python':sys.version.split()[0],'platform':sys.platform},'source_sha256':sha((ROOT/'src/release_engineer.py').read_bytes()),'cases':results,'candidate_controls_pass':all(c['candidate']['accepted']==c['expected_accept']for c in results),'current_negative_false_accepts':[c['case']for c in results if not c['expected_accept']and c['current']['accepted']],'extracted_members':0,'executed_members':0,'provider_tasks':0,'source_modified':False,'full_regression':'NOT_RUN_RESEARCH_ONLY','runtime_integrated':'UNVERIFIED','global_promotion':'NOT_PERFORMED'}
 out=Path(__file__).with_name('RESULT.json')
 with out.open('x',encoding='utf-8')as f:json.dump(report,f,indent=2);f.write('\n')
 print(json.dumps(report,indent=2))

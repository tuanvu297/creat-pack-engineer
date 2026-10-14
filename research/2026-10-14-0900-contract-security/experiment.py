"""Synthetic offline checks; no provider calls or release source changes."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import hashlib, importlib.util, json, math, subprocess, sys, zipfile

sys.dont_write_bytecode = True
ROOT=Path(__file__).parent
SOURCE=Path('D:/Codex/ai-release-engineer/src/release_engineer.py')
NODE=Path('C:/Users/tuanv/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
spec=importlib.util.spec_from_file_location('toolkit_under_test',SOURCE)
tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)
def digest(data):return hashlib.sha256(data).hexdigest()
def no_constant(_):raise ValueError('NON_FINITE_NUMBER')
def unique_pairs(pairs):
    result={}
    for name,value in pairs:
        if name in result:raise ValueError('DUPLICATE_KEY')
        result[name]=value
    return result
def strict_load(raw):
    return json.loads(raw,parse_constant=no_constant,object_pairs_hook=unique_pairs)
def make(name,variant,payload=b"print('synthetic baseline')\n"):
    manifest={'package_name':'fixture','package_version':'1.0.0','purpose':'synthetic fixture',
      'created_at':'2026-10-14T02:00:00+00:00','runtime_requirements':['Python 3.10+'],
      'dependencies':[],'entrypoints':['bin/demo.py'],'input_contract':{},
      'output_contract':{},'files':[{'path':'bin/demo.py','size':len(payload),'sha256':digest(payload)}],
      'known_limits':['synthetic fixture; do not execute'],'authentication_requirements':[],
      'test_status':{'LOCAL_FUNCTION_PASS':'UNVERIFIED'}}
    if variant=='nonfinite':manifest['input_contract']={'confidence':math.nan}
    raw=json.dumps(manifest,ensure_ascii=True)
    if variant=='duplicate':raw=raw.replace('"purpose": "synthetic fixture"','"purpose": "first", "purpose": "second"')
    path=ROOT/(name+'.zip')
    if path.exists():raise ValueError('Fresh fixture path required')
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('fixture/bin/demo.py',payload)
        archive.writestr('fixture/MANIFEST.json',raw.encode())
    return path,raw

observations=[]
fixtures=[]
for variant in ['baseline','nonfinite','duplicate']:
    path,raw=make(variant,variant);fixtures.append(path)
    current=tool.verify_zip(path)
    try:strict_load(raw);strict_accept=True
    except ValueError:strict_accept=False
    node=subprocess.run([str(NODE),'-e',
      'try {JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write("ACCEPT")} catch {process.stdout.write("REJECT"); process.exitCode=2}',
      ],input=raw,text=True,capture_output=True,timeout=15)
    observations.append({'case':variant,'current_toolkit_structure_verification':current['PACKAGE_BUILT'],
       'candidate_strict_parser_accepts':strict_accept,'node_json_parser_accepts':node.returncode==0,
       'zip_sha256':digest(path.read_bytes())})
assert observations[0]['candidate_strict_parser_accepts'] and observations[0]['node_json_parser_accepts']
assert not observations[1]['candidate_strict_parser_accepts'] and not observations[1]['node_json_parser_accepts']
assert not observations[2]['candidate_strict_parser_accepts']
assert observations[2]['node_json_parser_accepts']
replacement,_=make('replaced-consistent','baseline',b"print('synthetic changed payload')\n")
trusted_expected=digest(fixtures[0].read_bytes())
replacement_structure=tool.verify_zip(replacement)
provenance={'baseline_matches_pinned_digest':digest(fixtures[0].read_bytes())==trusted_expected,
    'replacement_self_consistency':replacement_structure['PACKAGE_BUILT'],
    'replacement_matches_pinned_digest':digest(replacement.read_bytes())==trusted_expected,
    'publisher_identity_or_signature':'UNVERIFIED_NOT_TESTED',
    'interpretation':'Self-consistency is not provenance; expected digest must arrive through an independently trusted channel.'}
assert provenance['baseline_matches_pinned_digest'] and not provenance['replacement_matches_pinned_digest']
result={'task_id':'CREAT-PACK-LEARNING-20261014-0900',
 'recorded_at':datetime.now(timezone(timedelta(hours=7))).isoformat(),
 'runtime':{'python':sys.version.split()[0], 'node':subprocess.check_output([str(NODE),'--version'],text=True).strip()},
 'subject':{'toolkit_version':'0.1.0','source_path':SOURCE.as_posix(),'source_sha256':digest(SOURCE.read_bytes())},
 'scope':'Synthetic local negative fixtures; research proposals only. No source changes, provider, auth or integration test.',
 'observations':observations,'provenance_observation':provenance,
 'candidate_control_checks':{'baseline_accepted':True,'nonfinite_rejected':True,'duplicate_key_rejected':True,'replacement_digest_rejected':True},
 'candidate_control_status':'LOCAL_EXPERIMENT_PASS',
 'current_toolkit_gap':'OBSERVED: NaN/duplicate-key manifests pass structural verify; Node rejects NaN.',
 'global_skill_promotion':'NOT_PERFORMED','runtime_integrated':'UNVERIFIED','product_release':'NOT_BUILT'}
(ROOT/'RESULT.json').write_bytes((json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+'\n').encode())
print(json.dumps(result,ensure_ascii=True,allow_nan=False))

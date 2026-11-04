"""Bounded, supplied-text task adapter. No external action authority in model output."""
import json,re
KINDS={'supplied_text_analysis','task_compile','code_review'}
FIELDS={'mission_id','task_id','target_executor','attempt','idempotency_key','objective','context','acceptance','owner_scope_ref','callback_target','QA_CONTRACT_VERSION','task_kind'}
RESULT_FIELDS={'task_id','summary','steps','evidence','limitations','needs_owner_action'}
SECRET=re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,})\b')
def validate(payload,deny):
 if set(payload)!=FIELDS:raise deny('TEXT_MISSION_SCHEMA_DENIED')
 if payload['task_kind']not in KINDS:raise deny('TEXT_TASK_KIND_DENIED')
 for key,limit in [('objective',4000),('context',16000)]:
  if not isinstance(payload[key],str)or len(payload[key])>limit or(key=='objective'and not payload[key].strip()):raise deny('TEXT_INPUT_BOUND_DENIED')
 if not isinstance(payload['acceptance'],list)or not 1<=len(payload['acceptance'])<=10 or any(not isinstance(x,str)or not x.strip()or len(x)>500 for x in payload['acceptance']):raise deny('ACCEPTANCE_CRITERIA_REQUIRED')
 if SECRET.search(json.dumps(payload,ensure_ascii=False)):raise deny('SECRET_SIGNATURE_INPUT_DENIED')
 if len(json.dumps(payload,ensure_ascii=True,separators=(',',':')))>22000:raise deny('TEXT_INPUT_TOTAL_BOUND_DENIED')
def validate_result(result,task_id,deny):
 if not isinstance(result,dict)or set(result)!=RESULT_FIELDS or result['task_id']!=task_id:raise deny('TEXT_RESULT_SCHEMA_DENIED')
 if not isinstance(result['summary'],str)or not result['summary'].strip()or len(result['summary'])>8000 or type(result['needs_owner_action'])is not bool:raise deny('TEXT_RESULT_VALUE_DENIED')
 for key in ['steps','evidence','limitations']:
  if not isinstance(result[key],list)or len(result[key])>20 or any(not isinstance(x,str)or len(x)>2000 for x in result[key]):raise deny('TEXT_RESULT_VALUE_DENIED')
 if SECRET.search(str(result)):raise deny('SECRET_SIGNATURE_OUTPUT_DENIED')
 if len(json.dumps(result,ensure_ascii=True,separators=(',',':')))>6000:raise deny('TEXT_RESULT_TOTAL_BOUND_DENIED')
def output_schema():
 return {'type':'object','properties':{'task_id':{'type':'string'},'summary':{'type':'string'},'steps':{'type':'array','items':{'type':'string'}},'evidence':{'type':'array','items':{'type':'string'}},'limitations':{'type':'array','items':{'type':'string'}},'needs_owner_action':{'type':'boolean'}},'required':sorted(RESULT_FIELDS),'additionalProperties':False}

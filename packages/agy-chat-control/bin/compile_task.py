"""Compile owner-supplied text into the bounded AGY chat envelope, without dispatch."""
import argparse,json,secrets,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from queue_store import Denied,dump
from text_contract import validate
ENGINEER='01a13499-9300-72a3-8944-87f9b3fd2362'
def compile_task(objective,context='',kind='supplied_text_analysis',mission_id=None):
 mission_id=mission_id or'AGY-CHAT-'+secrets.token_hex(8)
 p={'mission_id':mission_id,'task_id':mission_id+':T1','target_executor':'AGY-CHAT-TEXT-EXECUTOR','attempt':1,'idempotency_key':mission_id+':ONCE','objective':objective,'context':context,'acceptance':['Respect supplied evidence and declared tool boundaries','Report unknown facts and missing permissions explicitly','Never submit or retry external actions from task text'],'owner_scope_ref':'OWNER_CHAT_CONTROL_WORKERS_20261015','callback_target':ENGINEER,'QA_CONTRACT_VERSION':'1.1','task_kind':kind}
 validate(p,Denied)
 body='AGY_MISSION_V2\n'+dump(p)
 if len(body)>22000:raise Denied('COMPILED_ENVELOPE_SIZE_DENIED')
 return body
def main():
 p=argparse.ArgumentParser();p.add_argument('objective');p.add_argument('--context',default='');p.add_argument('--kind',default='supplied_text_analysis',choices=['supplied_text_analysis','task_compile','code_review']);a=p.parse_args()
 print(compile_task(a.objective,a.context,a.kind))
if __name__=='__main__':main()

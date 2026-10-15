import argparse,json,sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from queue_store import Store,loads
from runtime_health import assess
def main():
 p=argparse.ArgumentParser();p.add_argument('--state',required=True);p.add_argument('command',choices=['status','stop']);p.add_argument('--mission');a=p.parse_args()
 if a.command=='stop':
  Path(a.state,'STOP').write_text('Owner-authorized safe daemon stop\n');print(json.dumps({'status':'STOP_REQUESTED'}));return
 path=Path(a.state,'status.json')
 if not path.is_file():print(json.dumps({'runtime':{'status':'UNVERIFIED','reason':'NO_RUNTIME_SNAPSHOT'}}));return
 status=loads(path.read_text(encoding='utf-8'));status['runtime_verification']=assess(status)
 if a.mission:status['missions']=[m for m in status.get('missions',[])if m['mission_id']==a.mission]
 print(json.dumps(status,indent=2,ensure_ascii=True))
if __name__=='__main__':main()

import argparse,json,sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from queue_store import Store,loads
def main():
 p=argparse.ArgumentParser();p.add_argument('--state',required=True);p.add_argument('command',choices=['status','stop']);p.add_argument('--mission');a=p.parse_args()
 if a.command=='stop':
  Path(a.state,'STOP').write_text('Owner-authorized safe daemon stop\n');print(json.dumps({'status':'STOP_REQUESTED'}));return
 s=Store(a.state)
 try:print(json.dumps(s.status(a.mission),indent=2,ensure_ascii=True))
 finally:s.close()
if __name__=='__main__':main()

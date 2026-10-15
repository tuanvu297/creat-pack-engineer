import queue,sys,tempfile,threading,time,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).parents[1]/'src'))
from appserver_client import AppServer
from queue_store import Denied
from daemon import Daemon

class TransportTests(unittest.TestCase):
 def test_expired_grant_sends_zero_rpc(self):
  a=AppServer.__new__(AppServer);sent=[];a.sequence=0;a.send=sent.append
  def expired():raise Denied('GRANT_EXPIRED')
  with self.assertRaisesRegex(Denied,'EXPIRED'):a.rpc('turn/start',{},heartbeat=expired)
  self.assertEqual(sent,[])
 def test_worker_tool_output_not_accepted(self):
  a=AppServer.__new__(AppServer);a.q=queue.Queue();a.history=[{'method':'item/completed','params':{'turnId':'t','item':{'type':'mcpToolCall'}}}]
  with self.assertRaisesRegex(Denied,'TOOL_ACTIVITY'):a.result('t',lambda:None,timeout=1)
 def test_snapshot_race_isolated(self):
  class FakeStore:
   def status(self):return []
  with tempfile.TemporaryDirectory() as root:
   a=Daemon.__new__(Daemon);a.root=Path(root);a.snapshot_lock=threading.RLock();a.binding={};a.stop=threading.Event();a.last_poll=None;a.poll_error=None;a.store=FakeStore()
   with ThreadPoolExecutor(8) as pool:results=list(pool.map(lambda _:a.snapshot(),range(200)))
   self.assertEqual(len(results),200);self.assertTrue((Path(root)/'status.json').is_file())
if __name__=='__main__':unittest.main(verbosity=2)

import type { EngineStore, WorkerAdapter } from '../types.js';
import { WorkerEngine } from '../engine.js';

export interface RuntimeLane {
 key:string; workerId:string; store:EngineStore; adapter:WorkerAdapter;
 // A durable, project-scoped sink; never exposes provider credentials/errors.
 report(state:'RUNNING'|'IDLE'|'BLOCKED'|'STOPPED',outcome?:string,error?:string):Promise<void>;
}
export interface DispatcherOptions {pollMs:number; heartbeatMs:number; leaseSeconds:number; concurrency:number}
export class DurableDispatcher {
 private active=new Map<string,Promise<void>>();
 private last=new Map<string,{state:'RUNNING'|'IDLE'|'BLOCKED';outcome?:string;error?:string}>();
 private stopped=false;
 private cursor=0;
 constructor(readonly lanes:RuntimeLane[],readonly options:DispatcherOptions) {
  if(!lanes.length||new Set(lanes.map(l=>l.key)).size!==lanes.length)throw new Error('INVALID_RUNTIME_LANES');
  if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>32||
   ![options.pollMs,options.heartbeatMs,options.leaseSeconds].every(Number.isFinite)||
   options.pollMs<20||options.heartbeatMs<20||options.leaseSeconds<1||
   options.pollMs>2147483647||options.heartbeatMs>2147483647||options.leaseSeconds>2147483)throw new Error('INVALID_RUNTIME_LIMITS');
 }
 async pulse() {
  // No await of a running worker: a slow/failed lane cannot hold up another lane.
  for(let offset=0;offset<this.lanes.length;offset++) {
   const index=(this.cursor+offset)%this.lanes.length,lane=this.lanes[index];
   if(this.active.has(lane.key)||this.active.size>=this.options.concurrency)continue;
   const operation=this.runLane(lane).finally(()=>this.active.delete(lane.key));
   this.active.set(lane.key,operation);
  }
  this.cursor=(this.cursor+1)%this.lanes.length;
 }
 private async report(lane:RuntimeLane,state:'RUNNING'|'IDLE'|'BLOCKED',outcome?:string,error?:string) {
  this.last.set(lane.key,{state,outcome,error});await lane.report(state,outcome,error);
 }
 private async runLane(lane:RuntimeLane) {
  try {
   // Reclaim before probing health so unavailable workers never prevent stale recovery.
   await lane.store.reclaimExpired();
   if(!(await lane.adapter.health()).ready){await this.report(lane,'BLOCKED',undefined,'CONNECTOR_UNAVAILABLE');return;}
   await this.report(lane,'RUNNING');
   const outcome=await new WorkerEngine(lane.store,lane.adapter,lane.workerId,this.options.leaseSeconds).tick();
   await this.report(lane,outcome==='BLOCKED'?'BLOCKED':'IDLE',outcome);
  }catch {try{await this.report(lane,'BLOCKED',undefined,'RUNTIME_LANE_FAILED');}catch{/* DB outage: existing heartbeat expires truthfully. */}}
 }
 async run(signal:AbortSignal) {
  let heartbeatAt=0;
  while(!signal.aborted&&!this.stopped) {
   await this.pulse();
   if(Date.now()-heartbeatAt>=this.options.heartbeatMs){
    await Promise.allSettled(this.lanes.map(l=>{const s=this.last.get(l.key);return l.report(s?.state??'BLOCKED',s?.outcome,s?.error??(s?undefined:'AWAITING_FIRST_POLL'));}));heartbeatAt=Date.now();
   }
   await new Promise<void>(resolve=>{if(signal.aborted){resolve();return;}const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,this.options.pollMs);signal.addEventListener('abort',done,{once:true});});
  }
  // Graceful stop lets accepted operations checkpoint/settle. Forced kill uses lease recovery.
  await Promise.allSettled(this.active.values());
  await Promise.allSettled(this.lanes.map(l=>l.report('STOPPED')));
 }
 stop(){this.stopped=true;}
}

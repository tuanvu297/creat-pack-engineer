import {Context} from '@temporalio/activity';
import type {TemporalBridge} from './bridge.js';
import type {Mission,Binding,Activities} from './contracts.js';
// PostgreSQL notifications are wakeups only. The store is reread after LISTEN,
// after reconnect/retry, and on runtime heartbeat: a missed NOTIFY cannot lose state.
export async function waitResult(bridge:TemporalBridge,m:Mission,b:Binding){
 const ctx=Context.current(),acts=bridge.activities();
 const c=await bridge.raw.connect();
 const deadline=Date.now()+m.result_timeout_ms;
 try{
  await c.query('LISTEN agy_temporal_result');
  while(Date.now()<deadline){
   ctx.cancellationSignal.throwIfAborted();
   b=await acts.heartbeat_checkpoint(m,b);ctx.heartbeat(b);
   const result=await acts.submit_result_evidence(m,b);
   if(result.state!=='RUNNING')return {binding:b,result};
   // Synthetic readiness is an explicit runtime timer, never a Workflow timer.
   const op=(await bridge.pool(m).query('SELECT ready_at FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
   const wake=Math.max(1,Math.min(5000,deadline-Date.now(),op?new Date(op.ready_at).getTime()-Date.now():5000));
   await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);c.off('notification',notify);c.off('error',error);ctx.cancellationSignal.removeEventListener('abort',abort);};
    const notify=(n:{payload?:string})=>{if(n.payload===b.workflow_id){cleanup();resolve();}};
    const error=(e:Error)=>{cleanup();reject(e);};const abort=()=>{cleanup();reject(ctx.cancellationSignal.reason);};
    const timer=setTimeout(()=>{cleanup();resolve();},wake);
    c.on('notification',notify);c.on('error',error);ctx.cancellationSignal.addEventListener('abort',abort,{once:true});
    if(ctx.cancellationSignal.aborted)abort();
   });
  }
  return {binding:b,result:{state:'RUNNING' as const}};
 }finally{await c.query('UNLISTEN agy_temporal_result').catch(()=>{});c.release();}
}

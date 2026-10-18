import test from 'node:test';
import assert from 'node:assert/strict';
import {DurableDispatcher,type RuntimeLane} from '../src/platform/dispatcher.js';
import {InMemoryStore} from './in-memory-store.js';
const delay=()=>new Promise(r=>setTimeout(r,10));
test('bounded dispatcher rotates over more lanes than slots and unavailable lane cannot freeze others',async()=>{
 const seen=new Set<string>(),states=new Map<string,string>();
 const lanes:RuntimeLane[]=Array.from({length:7},(_,i)=>({key:String(i),workerId:String(i),store:new InMemoryStore(),
  adapter:{name:'controlled',capabilities:[],health:async()=>{seen.add(String(i));return {ready:i!==0};},
   execute:async()=>{throw new Error('NO_SYNTHETIC_TASKS');},check_status:async()=>({state:'RUNNING' as const}),
   collect_result:async()=>({state:'RUNNING' as const}),cancel:async()=>{}},
  report:async s=>{states.set(String(i),s);}}));
 const dispatcher=new DurableDispatcher(lanes,{concurrency:2,pollMs:20,heartbeatMs:20,leaseSeconds:1});
 for(let i=0;i<9;i++){await dispatcher.pulse();await delay();}
 assert.equal(seen.size,7);assert.equal(states.get('0'),'BLOCKED');assert.equal(states.get('6'),'IDLE');
});

test('dispatcher rejects non-finite and overflowing runtime timers',()=>{
 const lane={key:'a'} as RuntimeLane;
 const valid={concurrency:1,pollMs:20,heartbeatMs:20,leaseSeconds:1};
 for(const field of ['pollMs','heartbeatMs','leaseSeconds'] as const)
  for(const value of [NaN,Infinity,-Infinity,2147483648])
   assert.throws(()=>new DurableDispatcher([lane],{...valid,[field]:value}),/INVALID_RUNTIME_LIMITS/);
});

test('unpolled lanes never receive healthy IDLE heartbeat',async()=>{
 const observations:{key:string;state:string;error?:string}[]=[];
 let finish!:()=>void;
 const held=new Promise<void>(resolve=>{finish=resolve;});
 const lanes:RuntimeLane[]=['a','b'].map(key=>({key,workerId:key,store:new InMemoryStore(),
  adapter:{name:'controlled',capabilities:[],health:async()=>{await held;return {ready:false};},
   execute:async()=>{throw new Error('NO_TASKS');},check_status:async()=>({state:'RUNNING' as const}),
   collect_result:async()=>({state:'RUNNING' as const}),cancel:async()=>{}},
  report:async(state,_outcome,error)=>{observations.push({key,state,error});}}));
 const stop=new AbortController();
 const dispatcher=new DurableDispatcher(lanes,{concurrency:1,pollMs:20,heartbeatMs:20,leaseSeconds:1});
 const run=dispatcher.run(stop.signal);
 try {await delay();assert.ok(observations.some(o=>o.key==='b'&&o.state==='BLOCKED'&&o.error==='AWAITING_FIRST_POLL'));
  assert.equal(observations.some(o=>o.state==='IDLE'),false);
 }finally{stop.abort();finish();await run;}
});

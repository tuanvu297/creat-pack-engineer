import {fork,type ChildProcess} from 'node:child_process';
export interface ChildSpec {name:string;file:string}
export function startSupervised(specs:ChildSpec[],graceMs=10000){
 if(specs.length!==2||new Set(specs.map(s=>s.name)).size!==2)throw new Error('TWO_DISTINCT_CHILDREN_REQUIRED');
 const children:ChildProcess[]=[],ready=new Set<string>(),failed=new Set<ChildProcess>();
 let stopping=false,finished=false,timer:ReturnType<typeof setTimeout>|undefined;
 let resolveDone:(code:number)=>void;
 const done=new Promise<number>(resolve=>{resolveDone=resolve;});
 let exitCode=1;
 const finish=()=>{if(finished)return;finished=true;if(timer)clearTimeout(timer);resolveDone(exitCode);};
 const broadcast=()=>{
  const gateway=children[specs.findIndex(s=>s.name==='gateway')];
  if(gateway?.connected)gateway.send({type:'worker-ready',ready:ready.has('worker')},()=>{});
 };
 const dead=(child:ChildProcess)=>failed.has(child)||child.exitCode!==null||child.signalCode!==null;
 const stop=(code=0)=>{
  if(stopping)return;stopping=true;exitCode=code;
  ready.clear();broadcast();
  for(const child of children)if(!dead(child))child.kill('SIGTERM');
  if(children.every(dead))return finish();
  timer=setTimeout(()=>{
   for(const child of children)if(!dead(child))child.kill('SIGKILL');
  },graceMs);
 };
 try{
  for(const spec of specs){
   if(stopping)break;
   const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^SUPABASE_/i.test(key)&&!['AGY_BOOTSTRAP_DATABASE_URL','AGY_DB_RUNTIME_PASSWORD','AGY_PROVISION_STAGING'].includes(key.toUpperCase())));
   const child=fork(spec.file,[],{env:childEnv,windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],execArgv:[]});
   children.push(child);
   child.on('message',(message:any)=>{
    if(!stopping&&spec.name==='worker'&&message?.type==='worker-ready'){ready.add('worker');broadcast();}
    if(!stopping&&spec.name==='gateway'&&message?.type==='gateway-listening')broadcast();
   });
   child.on('spawn',broadcast);
   child.on('error',()=>{failed.add(child);stop(1);if(children.every(dead))finish();});
   child.on('exit',()=>{
    ready.delete(spec.name);broadcast();
    if(!stopping)stop(1); // Even unexpected exit 0 must restart both halves.
    if(children.every(dead))finish();
   });
  }
 }catch{stop(1);}
 const startupTimer=setTimeout(()=>{if(!ready.has('worker'))stop(1);},30000);
 void done.then(()=>clearTimeout(startupTimer));
 return {children,done,stop};
}

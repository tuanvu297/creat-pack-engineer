import {createServer} from 'node:http';
import {authenticate,type IdentityConfig} from '../platform/auth.js';
export interface GatewayHttpDependencies {
 identities:IdentityConfig[];
 execute:(mission:any,principal:any,action:string,verdict?:any)=>Promise<any>;
 health:()=>Promise<{postgres:boolean;temporal:boolean;worker:boolean}>;
}
export function createGatewayHttpServer(deps:GatewayHttpDependencies){
 return createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  res.setHeader('cache-control','no-store');
  try{
   if(req.method==='GET'&&req.url==='/health'){
    let state={postgres:false,temporal:false,worker:false};
    try{state=await deps.health();}catch{}
    const ready=state.postgres&&state.temporal&&state.worker;
    res.statusCode=ready?200:503;
    res.end(JSON.stringify({status:ready?'READY':'BLOCKED',dependencies:state,mode:'TEMPORAL_SHADOW',canonical_authority:'EXISTING_POSTGRES_D049',production:false}));
    return;
   }
   // Authenticate every action before disclosing routing or reading request bodies.
   const principal=authenticate(req.headers.authorization,deps.identities);
   if(req.method!=='POST')throw new Error('POST_REQUIRED');
   const action=/^\/v1\/agy\/(bootstrap|current_state|dispatch|task_status|get_run|active_missions|reconcile|submit_qa|callback_status|stop)$/.exec(req.url??'')?.[1];
   if(!action)throw new Error('UNKNOWN_GATEWAY_ACTION');
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of req){
    size+=chunk.length;if(size>65536)throw new Error('REQUEST_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
   }
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   res.end(JSON.stringify(await deps.execute(body.mission,principal,action,body.verdict)));
  }catch(e){
   const message=e instanceof Error?e.message:'REQUEST_FAILED';
   res.statusCode=message==='UNAUTHORIZED'?401:/DENIED/.test(message)?403:message==='REQUEST_TOO_LARGE'?413:400;
   res.end(JSON.stringify({error:/^[A-Z_]+$/.test(message)?message:'REQUEST_FAILED'}));
  }
 });
}

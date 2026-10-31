import {createServer} from 'node:http';
import {authenticate,type IdentityConfig,type Principal} from '../platform/auth.js';
import type {ProjectScope} from '../platform/scope.js';
export interface GatewayHttpDependencies {
 identities:IdentityConfig[];
 execute:(mission:any,principal:any,action:string,verdict?:any)=>Promise<any>;
 health:()=>Promise<{postgres:boolean;temporal:boolean;worker:boolean}>;
 worker?:(principal:Principal,scope:ProjectScope,action:string,body:any)=>Promise<any>;
 ui?:(req:any,res:any)=>Promise<boolean>;
 callbacks?:{receive:(principal:Principal,scope:ProjectScope,body:any)=>Promise<any>;lookup:(principal:Principal,scope:ProjectScope,callbackId:string)=>Promise<any>};
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
   // The browser worker UI (when wired) owns its session authentication.
   if(deps.ui&&await deps.ui(req,res))return;
   // Authenticate every action before disclosing routing or reading request bodies.
   const principal=authenticate(req.headers.authorization,deps.identities);
   const cbMatch=/^\/v1\/callbacks\/tenants\/([A-Za-z0-9_-]+)\/workspaces\/([A-Za-z0-9_-]+)\/projects\/([A-Za-z0-9_-]+)\/receive(?:\/([a-f0-9-]{36}))?$/.exec(req.url??'');
   if(cbMatch){
    if(!deps.callbacks)throw new Error('CALLBACK_RECEIVER_DISABLED');
    const cbScope={tenantId:cbMatch[1],workspaceId:cbMatch[2],projectId:cbMatch[3]};
    if(req.method==='GET'&&cbMatch[4]){
     const out=await deps.callbacks.lookup(principal,cbScope,cbMatch[4]);
     res.statusCode=out.found?200:404;res.end(JSON.stringify(out));return;
    }
    if(req.method==='POST'&&!cbMatch[4]){
     const cchunks:Buffer[]=[];let csize=0;
     for await(const chunk of req){csize+=chunk.length;if(csize>65536)throw new Error('REQUEST_TOO_LARGE');cchunks.push(Buffer.from(chunk));}
     const cbody=cchunks.length?JSON.parse(Buffer.concat(cchunks).toString('utf8')):{};
     try{res.end(JSON.stringify(await deps.callbacks.receive(principal,cbScope,cbody)));}
     catch(e){const m=e instanceof Error?e.message:'';
      if(m==='CALLBACK_DIGEST_CONFLICT'||m==='CALLBACK_TUPLE_CONFLICT'){res.statusCode=409;res.end(JSON.stringify({error:m}));return;}
      if(m==='CALLBACK_NOT_FOUND'){res.statusCode=404;res.end(JSON.stringify({error:m}));return;}
      throw e;}
     return;
    }
    throw new Error('CALLBACK_ROUTE_NOT_FOUND');
   }
   if(req.method!=='POST')throw new Error('POST_REQUIRED');
   const workerMatch=/^\/v1\/worker\/tenants\/([A-Za-z0-9_-]+)\/workspaces\/([A-Za-z0-9_-]+)\/projects\/([A-Za-z0-9_-]+)\/(arrive|recover|claim|ack|heartbeat|checkpoint|result|readback)$/.exec(req.url??'');
   if(workerMatch){
    if(!deps.worker)throw new Error('WORKER_SURFACE_DISABLED');
    const wchunks:Buffer[]=[];let wsize=0;
    for await(const chunk of req){wsize+=chunk.length;if(wsize>65536)throw new Error('REQUEST_TOO_LARGE');wchunks.push(Buffer.from(chunk));}
    const wbody=wchunks.length?JSON.parse(Buffer.concat(wchunks).toString('utf8')):{};
    res.end(JSON.stringify(await deps.worker(principal,{tenantId:workerMatch[1],workspaceId:workerMatch[2],projectId:workerMatch[3]},workerMatch[4],wbody)));
    return;
   }
   const action=/^\/v1\/agy\/(bootstrap|current_state|dispatch|task_status|get_run|active_missions|reconcile|submit_qa|callback_status|stop|r11_control)$/.exec(req.url??'')?.[1];
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

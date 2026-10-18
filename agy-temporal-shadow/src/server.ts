import { createServer } from 'node:http';
import { Pool } from 'pg';
import { authenticate,identitiesFromEnv } from './platform/auth.js';
import { ProjectService } from './platform/service.js';
import { GlobalLearningStore } from './platform/global-store.js';
if(process.env.AGY_STAGE_ONLY!=='true')throw new Error('EXPERIMENTAL_PLATFORM_STAGING_ONLY: read PLATFORM-RUNBOOK.md');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const identities=identitiesFromEnv();const pool=new Pool({connectionString:process.env.DATABASE_URL});
const approvalPool=process.env.AGY_GLOBAL_APPROVAL_DATABASE_URL?new Pool({connectionString:process.env.AGY_GLOBAL_APPROVAL_DATABASE_URL}):undefined;
const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
if(!role||role.rolsuper||role.rolbypassrls)throw new Error('RUNTIME_ROLE_MUST_NOT_BYPASS_RLS');
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 try {
  if(req.url==='/health'&&req.method==='GET'){await pool.query('SELECT 1');res.end(JSON.stringify({ready:false,stageOnly:true,reason:'PLATFORM_ACCEPTANCE_INCOMPLETE'}));return;}
  const principal=authenticate(req.headers.authorization,identities);
  if(req.url?.startsWith('/v1/platform/global-learning/')&&req.method==='POST') {
   if(principal.role!=='platform-admin')throw new Error('GLOBAL_APPROVAL_DENIED');
   if(!approvalPool)throw new Error('GLOBAL_APPROVAL_CONNECTION_REQUIRED');
   const library=new GlobalLearningStore(approvalPool,principal),body=await json(req);
   if(req.url==='/v1/platform/global-learning/propose'){res.end(JSON.stringify(await library.propose(body)));return;}
   if(req.url==='/v1/platform/global-learning/promote'){res.end(JSON.stringify(await library.promote(body.candidate_id,body.fingerprint)));return;}
  }
  const match=/^\/v1\/tenants\/([A-Za-z0-9_-]+)\/workspaces\/([A-Za-z0-9_-]+)\/projects\/([A-Za-z0-9_-]+)(\/[^?]*)$/.exec(req.url??'');
  if(!match){res.statusCode=404;res.end(JSON.stringify({error:'PROJECT_SCOPED_ROUTE_REQUIRED'}));return;}
  const service=new ProjectService(pool,{tenantId:match[1],workspaceId:match[2],projectId:match[3]},principal);
  const result=await service.execute(match[4],req.method??'',req.method==='POST'?await json(req):{});
  if(result===undefined){res.statusCode=404;res.end(JSON.stringify({error:'NOT_FOUND'}));return;}
  res.end(JSON.stringify(result));
 }catch(error){const message=error instanceof Error?error.message:'REQUEST_FAILED';res.statusCode=message==='UNAUTHORIZED'?401:/DENIED|AUTHORITY/.test(message)?403:400;
  res.end(JSON.stringify({error:/^[A-Z_]+$/.test(message)?message:'REQUEST_FAILED'}));}
});
server.listen(Number(process.env.PORT??8787),'127.0.0.1');
async function json(req:any){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1048576)throw new Error('REQUEST_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}

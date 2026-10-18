// Disposable connector verification fixture. REAL Codex inference, no production actions.
import { createServer } from 'node:http';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,readFile,writeFile,open,readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
if(process.env.AGY_SPRINT4_DISPOSABLE!=='true')throw new Error('DISPOSABLE_ONLY');
const session=JSON.parse(await readFile(resolve('../../work/sprint4/session.json'),'utf8'));
const ledger=resolve(session.work,'connector-ledger-'+session.run),sandbox=resolve(session.work,'connector-sandbox');await mkdir(ledger,{recursive:true});await mkdir(sandbox,{recursive:true});
const command=process.env.AGY_SPRINT4_CODEX_EXE!;if(!command)throw new Error('CODEX_EXE_REQUIRED');
const execute=promisify(execFile),children=new Map<string,ReturnType<typeof spawn>>(),faults=new Map<string,{status:number;remaining:number;delay?:number}>();
const poolId='codex-chatgpt-account-sprint4',record=async(op:any)=>writeFile(resolve(ledger,op.externalId+'.json'),JSON.stringify(op));
const load=async(id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('INVALID_ID');return JSON.parse(await readFile(resolve(ledger,id+'.json'),'utf8'));};
const result=(op:any)=>({...op.result,state:op.state,externalOperationId:op.externalId,sharedResourcePoolId:poolId});
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 const isControl=req.url==='/test/control';const expected=isControl?session.connectorAdminToken:session.connectorToken;
 if(req.headers.authorization!=='Bearer '+expected){res.writeHead(403);res.end(JSON.stringify({error:'PERMISSION_DENIED'}));return;}
 try {
  const chunks:Buffer[]=[];for await(const chunk of req){chunks.push(chunk);if(chunks.reduce((n,c)=>n+c.length,0)>65536)throw new Error('INVALID_INPUT');}
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  if(isControl){faults.set(body.path,{status:body.status,remaining:body.count,delay:body.delay});res.end('{}');return;}
  const fault=faults.get(req.url??'');if(fault&&fault.remaining>0){fault.remaining--;if(fault.delay)await new Promise(r=>setTimeout(r,fault.delay));if(fault.status!==200){res.setHeader('retry-after','.2');res.writeHead(fault.status);res.end(JSON.stringify({error:'CONTROLLED_FAULT_INJECTION'}));return;}}
  if(req.url==='/health'){const auth=await execute(command,['login','status'],{windowsHide:true,timeout:10000});res.end(JSON.stringify({ready:true,authType:/ChatGPT/.test(auth.stderr+auth.stdout)?'ChatGPT':'other',scope:'synthetic read-only inference',shared_resource_pool_id:poolId,credentialLeastPrivilegeVerified:false}));return;}
  if(req.url==='/execute'&&req.method==='POST') {
   const task=body.task,key=body.idempotency_key;
   if(!task?.taskId||task.payload?.verification!=='AGY_SPRINT4'||!/^[a-f0-9]{64}$/.test(key)||req.headers['idempotency-key']!==key)throw new Error('INVALID_INPUT');
   const digest=createHash('sha256').update(JSON.stringify(task.payload)).digest('hex'),keyPath=resolve(ledger,'key-'+key+'.json');
   let file;try{file=await open(keyPath,'wx');}catch(e:any){if(e.code!=='EEXIST')throw e;const prior=JSON.parse(await readFile(keyPath,'utf8'));if(prior.digest!==digest)throw new Error('IDEMPOTENCY_CONFLICT');res.end(JSON.stringify({externalId:prior.externalId,duplicate:true}));return;}
   const op:any={externalId:randomUUID(),key,digest,state:'RUNNING',createdAt:new Date().toISOString(),shared_resource_pool_id:poolId,submissions:1,events:[]};
   await file.writeFile(JSON.stringify({externalId:op.externalId,digest}));await file.close();await record(op);
   const child=spawn(command,['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','-c','approval_policy="never"','-c','web_search="disabled"','-c','features.plugins=false',
    'Return exactly {"verification":"AGY_SPRINT4","sum":42}. Do not call any tools, read files, or perform actions. This is a synthetic non-production connector verification.'],{cwd:sandbox,windowsHide:true,stdio:['ignore','pipe','pipe']});
   children.set(op.externalId,child);let output='',err='';child.stdout?.on('data',d=>output+=d);child.stderr?.on('data',d=>err+=d);
   child.on('error',async()=>{op.state='FAILED';op.result={error:{code:'CONNECTOR_UNAVAILABLE',message:'CLI spawn failed',retryable:true}};await record(op);});
   child.on('close',async(code)=>{children.delete(op.externalId);if(op.state==='CANCELLED'){await record(op);return;}
    const events=output.trim().split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});op.events=events;
    const unsafe=events.some(e=>/command_execution|mcp_tool_call|web_search|file_change/.test(e.item?.type??''));
    const text=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text;
    let answer;try{answer=JSON.parse(text);}catch{}
    const usage=events.find(e=>e.type==='turn.completed')?.usage;
    const pass=code===0&&!unsafe&&answer?.verification==='AGY_SPRINT4'&&answer?.sum===42;
    op.state=pass?'SUCCEEDED':'FAILED';op.finishedAt=new Date().toISOString();op.exitCode=code;
    op.result={output:answer??{},model:'codex-cli-default',tool:'codex exec read-only',tokens:usage?Number(usage.input_tokens??0)+Number(usage.output_tokens??0):undefined,quotaUnits:1,providerUsage:usage,
     qa:{deterministicPassed:pass,score:pass?1:0,confidence:1,evidenceSufficient:!!answer},error:pass?undefined:{code:unsafe?'PERMISSION_DENIED':/rate|429/i.test(err)?'RATE_LIMIT':'CONNECTOR_FAILURE',message:'CLI request did not satisfy deterministic test',retryable:!unsafe}};
    // No credential/config files or stderr are exported.
    await record(op);
   });
   res.writeHead(202);res.end(JSON.stringify({externalId:op.externalId,duplicate:false}));return;
  }
  const path=/^\/(status|result|usage|cancel)\/([a-f0-9-]{36})$/.exec(req.url??'');
  if(path){const op=await load(path[2]);if(path[1]==='cancel'){
    const child=children.get(op.externalId);if(child){op.state='CANCELLED';await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});await record(op);}res.end(JSON.stringify({cancelled:op.state==='CANCELLED',terminal:['SUCCEEDED','FAILED'].includes(op.state),remoteCancellationConfirmed:false}));return;
   }
   if(path[1]==='usage'){res.end(JSON.stringify({tokens:op.result?.tokens,quotaUnits:op.result?.quotaUnits,providerUsage:op.result?.providerUsage,sharedResourcePoolId:poolId,providerQuotaRemaining:null,costAmount:null}));return;}
   res.end(JSON.stringify(result(op)));return;
  }
  if(req.url==='/test/ledger'&&req.method==='GET'){const rows=[];for(const file of await readdir(ledger))if(/^[a-f0-9-]{36}\.json$/.test(file))rows.push(JSON.parse(await readFile(resolve(ledger,file),'utf8')));res.end(JSON.stringify(rows));return;}
  res.writeHead(404);res.end('{}');
 }catch{res.writeHead(400);res.end(JSON.stringify({error:'INVALID_INPUT'}));}
});
server.listen(55475,'127.0.0.1',()=>console.log('SPRINT4_REAL_CODEX_CONNECTOR_READY'));

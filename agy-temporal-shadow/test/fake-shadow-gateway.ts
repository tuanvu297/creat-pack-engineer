import {createServer, type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {Script,createContext} from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {stable} from '../src/gateway-shadow/journal.js';
import type {Json,Lease} from '../src/gateway-shadow/transport.js';

export const spec = {name:'controlled read',taskType:'text',payload:{input:'controlled'},risk:'LOW',
  estimatedCost:0,permissionGranted:true,safetyApproved:true,requiredCapabilities:['text'],requiredPermissions:['read']};
// This is a controlled model of the observed RPC contract, not a PostgreSQL substitute.
// The HTTP router itself is the exact deployed Railway source, evaluated with an in-memory RPC backend.
export class FakeShadowGateway {
  url = ''; server!: Server;
  calls: {path:string;headers:Record<string,string>;body:Json}[] = [];
  rpcCalls: {name:string;action:string;payload:Json}[] = [];
  tasks = new Map<string,Json>();
  checkpoints = new Map<number,Json>();
  result?: Json; callback?: Json; lease?: Lease;
  state = 'ROUTED'; leased = false; registered = false; queueArchived = false;
  dropAfter?: string; reject?: string; invalid?: string; badClaim: Json = {};
  onHeartbeat?: () => void;
  sourceHash = '';
  async start() {
    const source = await readFile(new URL('./fixtures/railway-gateway-20261018.txt',import.meta.url),'utf8');
    this.sourceHash = createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex');
    const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports: any = {};
    const context = createContext({exports,Request,Response,URL,JSON,Boolean,Number,
      Bun:{env:{SUPABASE_URL:'http://controlled-rpc.invalid',SUPABASE_SERVICE_ROLE_KEY:'CONTROLLED_FAKE'}},
      fetch:async (url:string,init:RequestInit) => {
        if (!url.startsWith('http://controlled-rpc.invalid/rest/v1/rpc/')) throw new Error('EXTERNAL_NETWORK_DENIED');
        const body = JSON.parse(String(init.body));
        const name = url.split('/').at(-1)!;
        const action = body.p_action ?? (name.includes('claim') ? 'claim' : 'callback');
        this.rpcCalls.push({name,action,payload:body.p_payload});
        try {return Response.json(this.rpc(action,body.p_payload));}
        catch {return Response.json({code:'CONTROLLED_REJECTION'},{status:409});}
      }});
    new Script(code).runInContext(context);
    this.server = createServer(async (req,res) => {
      try {
        const parts: Buffer[] = []; for await (const p of req) parts.push(Buffer.from(p));
        const body = Buffer.concat(parts).toString(), path = req.url!;
        this.calls.push({path,headers:req.headers as Record<string,string>,body:body ? JSON.parse(body) : {}});
        if (this.reject === path) {res.writeHead(409);res.end('{}');return;}
        const response: Response = await exports.default.fetch(new Request(this.url + path,
          {method:req.method,headers:req.headers as Record<string,string>,...(body ? {body} : {})}));
        if (this.dropAfter === path) {req.socket.destroy();return;}
        res.writeHead(response.status,{'content-type':'application/json'});
        res.end(this.invalid === path ? JSON.stringify({status:'PASS'}) : await response.text());
      } catch {res.writeHead(500);res.end('{}');}
    });
    await new Promise<void>(resolve => this.server.listen(0,'127.0.0.1',resolve));
    this.url = 'http://127.0.0.1:' + (this.server.address() as any).port;
    return this;
  }
  async close() {this.server.closeAllConnections();await new Promise<void>(resolve => this.server.close(() => resolve()));}
  private rpc(action: string, p: Json): Json {
    if (action === 'health') return {status:'PASS',mode:'SHADOW_STAGING',canonical_authority:'EXISTING_POSTGRES_D049'};
    if (action === 'register_worker') {this.registered = true;return {status:'PASS',worker_id:p.worker_id,health:'ONLINE'};}
    if (action === 'create_task') {
      const old = this.tasks.get(p.task_id);
      if (old && ['mission_id','trace_id','idempotency_key'].some(k => old[k] !== p[k])) throw new Error();
      if (!old) this.tasks.set(p.task_id,structuredClone(p));
      return {status:old ? 'IDEMPOTENT_REPLAY' : 'CREATED',task_id:p.task_id,mission_id:p.mission_id,trace_id:p.trace_id};
    }
    if (action === 'claim') {
      if (this.leased || !this.tasks.size) return {status:'EMPTY'};
      if (!this.registered) throw new Error();
      const task = [...this.tasks.values()][0]; this.leased = true; this.state = 'LEASED';
      this.lease = {status:'LEASED',task_id:task.task_id,mission_id:task.mission_id,attempt_id:'ATT-CONTROLLED',attempt_no:1,
        worker_id:p.worker_id,idempotency_key:task.idempotency_key,trace_id:task.trace_id,lease_token:'11111111-1111-4111-8111-111111111111',
        fence:7,expires_at:new Date(Date.now()+120000).toISOString(),payload:task.payload,acceptance_criteria:{},...this.badClaim} as Lease;
      return this.lease;
    }
    const lease = this.lease!;
    if (!lease || ['task_id','attempt_id','trace_id','idempotency_key'].some(k => p[k] !== (lease as any)[k])) throw new Error();
    if (action === 'callback') {
      if (!this.result) throw new Error();
      this.callback = structuredClone(p);
      return {status:p.callback_status,callback_id:p.callback_id,task_id:p.task_id,attempt_id:p.attempt_id};
    }
    if (this.state === 'RESULT_SUBMITTED' || ['worker_id','lease_token','fence'].some(k => p[k] !== (lease as any)[k]) ||
        Date.parse(lease.expires_at) <= Date.now()) throw new Error();
    const response = {task_id:p.task_id,attempt_id:p.attempt_id,fence:lease.fence};
    if (action === 'ack') {
      if (this.state !== 'LEASED') throw new Error(); this.state = 'ACKED'; return {...response,status:this.state};
    }
    if (action === 'heartbeat') {
      if (this.state === 'ACKED') this.state = 'RUNNING';
      lease.expires_at = new Date(Date.now()+p.lease_seconds*1000).toISOString();
      this.onHeartbeat?.();
      return {...response,status:this.state,expires_at:lease.expires_at};
    }
    if (!['ACKED','RUNNING','CHECKPOINTED'].includes(this.state)) throw new Error();
    if (action === 'checkpoint') {
      if (!this.checkpoints.has(p.version)) this.checkpoints.set(p.version,structuredClone(p.state));
      this.state = 'CHECKPOINTED'; return {...response,status:this.state,version:p.version};
    }
    if (action === 'result') {
      this.result = structuredClone(p);this.state = 'RESULT_SUBMITTED';this.queueArchived = true;
      return {...response,status:this.state,result_version:p.result_version,result_status:p.result_status,queue_archived:true};
    }
    throw new Error('UNSUPPORTED');
  }
  count(path:string) {return this.calls.filter(c => c.path === path).length;}
  checkpointDigest() {return stable([...this.checkpoints]);}
}

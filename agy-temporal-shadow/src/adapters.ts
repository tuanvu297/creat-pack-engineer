import type { ClaimedTask, ExecutionResult, WorkerAdapter,ProviderRuntimeProfile } from "./types.js";
import { createHash } from 'node:crypto';

export class ConnectorError extends Error {
  constructor(readonly code:string,readonly retryable:boolean,readonly retryAfterMs?:number){super(code);}
}
export function connectorIdempotencyKey(adapter:string,task:ClaimedTask){
 // Keep retries of the same submission stable; a terminal failed operation permits a
 // new attempt. Crash recovery uses its persisted externalId and never resubmits.
 return task.checkpoint?.idempotencyKey??createHash('sha256').update(JSON.stringify([adapter,task.taskId,task.submissionGeneration??0,task.payload??{}])).digest('hex');
}
export function codexVerificationProfile(observedAt:number):ProviderRuntimeProfile {
 return {provider:'OpenAI/Codex CLI',connector_id:'sprint4-codex',credential_scope_class:'ACCOUNT_LOGIN',execution_mode:'async',
  supports_status:'SUPPORTED',supports_collect:'SUPPORTED',supports_remote_cancel:'UNVERIFIED',supports_native_idempotency:'UNVERIFIED',
  supports_resume:'SUPPORTED',supports_usage:'SUPPORTED',supports_cost:'UNVERIFIED',supports_quota_remaining:'UNVERIFIED',supports_retry_after:'SUPPORTED',supports_background:'UNVERIFIED',
  shared_resource_pool_id:'codex-chatgpt-account-sprint4',model:null,version:null,capability_snapshot_version:'MISSION5-1',
  health_freshness:{observed_at:observedAt,max_age_ms:60000},risk_constraints:['LOW'],classification:'VERIFICATION_ONLY',
  core_evidence_ref:'SPRINT4-LIVE-CONNECTOR-EVIDENCE.json',submission_replay:'DURABLE_GATEWAY'};
}
export function stagingClassification(profile:ProviderRuntimeProfile,evidence:{realExecution:boolean;credentialBoundary:boolean;crashRecovery:boolean;accounting:boolean;isolation:boolean;core:boolean}){
 return profile.credential_scope_class==='STAGING_SERVICE'&&profile.core_evidence_ref&&Object.values(evidence).every(x=>x===true)?'ACCEPTED_STAGING':profile.credential_scope_class==='STAGING_SERVICE'?'LIMITED_STAGING':'VERIFICATION_ONLY';
}

export class StubAdapter implements WorkerAdapter {
  readonly capabilities: string[];
  constructor(readonly name: string, capabilities: string[], private readonly reason = "Connector endpoint/credentials not verified") {
    this.capabilities = capabilities;
  }
  async execute(_task: ClaimedTask, _signal: AbortSignal): Promise<{ externalId: string }> { throw new Error(`${this.name}: ${this.reason}`); }
  async check_status(_externalId: string): Promise<ExecutionResult> { return { state: "FAILED", error: { code: "CONNECTOR_UNAVAILABLE", message: this.reason, retryable: false } }; }
  async cancel(_externalId: string): Promise<void> {}
  async collect_result(externalId: string): Promise<ExecutionResult> { return this.check_status(externalId); }
  async health(): Promise<{ ready: boolean; detail?: string }> { return { ready: false, detail: this.reason }; }
  async usage(){return {};}
}

export class HttpJsonAdapter implements WorkerAdapter {
  constructor(readonly name: string, readonly capabilities: string[], private readonly endpoint: string, private readonly token?: string,readonly runtimeProfile?:ProviderRuntimeProfile,private readonly scopeHeaders:Record<string,string>={}) {}
  protected async call(path: string, body?: unknown, signal?: AbortSignal, idempotencyKey?:string) {
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
    for(let retry=0;retry<=2;retry++){
      let response:Response;
      try{response=await fetch(`${this.endpoint}${path}`, { method: body ? "POST" : "GET", signal:bounded,headers: { ...this.scopeHeaders,"content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{}) }, body: body ? JSON.stringify(body) : undefined });}
      catch{if(body&&idempotencyKey&&(!this.runtimeProfile||this.runtimeProfile.submission_replay==='BLOCK_ON_UNCERTAINTY'))throw new ConnectorError('SUBMISSION_UNCERTAIN',false);
        if(bounded.aborted)throw new ConnectorError('CONNECTOR_TIMEOUT',true);if(retry===2)throw new ConnectorError('CONNECTOR_UNAVAILABLE',true);await pause(100*(retry+1),bounded);continue;}
      if(response.ok){const data=await response.json() as any;return {...data,_agy_request_id:response.headers.get('x-request-id')??undefined};}
      // Provider quota exhaustion is not a transient rate limit. Never export raw errors.
      let providerCode:string|undefined;try{providerCode=(await response.json() as any)?.error?.code;}catch{}
      if(['insufficient_quota','credit_balance_exhausted'].includes(providerCode??''))throw new ConnectorError('PROVIDER_QUOTA_EXHAUSTED',false);
      const delay=response.headers.get('retry-after'),ms=delay?(Number.isFinite(Number(delay))?Number(delay)*1000:Math.max(0,Date.parse(delay)-Date.now())):100*(retry+1);
      const transient=[429,502,503,504].includes(response.status);
      if(body&&idempotencyKey&&response.status!==429&&transient&&(!this.runtimeProfile||this.runtimeProfile.submission_replay==='BLOCK_ON_UNCERTAINTY'))throw new ConnectorError('SUBMISSION_UNCERTAIN',false);
      const code=response.status===429?'RATE_LIMIT':[401,403].includes(response.status)?'PERMISSION_DENIED':[400,409,422].includes(response.status)?'INVALID_INPUT':transient?'CONNECTOR_TEMPORARY_FAILURE':'CONNECTOR_FAILURE';
      if(!transient||retry===2||!Number.isFinite(ms)||ms>5000)throw new ConnectorError(code,transient,ms);
      await pause(ms,bounded);
    }
    throw new ConnectorError('CONNECTOR_UNAVAILABLE',true);
  }
  async execute(task: ClaimedTask, signal: AbortSignal) {
    const key=connectorIdempotencyKey(this.name,task);
    return this.call("/execute", { task,idempotency_key:key },signal,key);
  }
  async check_status(externalId: string) { return this.call(`/status/${encodeURIComponent(externalId)}`) as Promise<ExecutionResult>; }
  async cancel(externalId: string) { const result=await this.call(`/cancel/${encodeURIComponent(externalId)}`, {});if(result.remoteCancellationConfirmed!==true&&result.terminal!==true)throw new ConnectorError('CANCELLATION_UNCONFIRMED',false); }
  async collect_result(externalId: string) { return this.call(`/result/${encodeURIComponent(externalId)}`) as Promise<ExecutionResult>; }
  async health():Promise<{ready:boolean;detail?:string}> { try { const status=await this.call("/health");return {ready:status.ready===true,detail:status.detail}; } catch (error) { return { ready: false, detail: String(error) }; } }
  async usage(externalId:string){return this.call(`/usage/${encodeURIComponent(externalId)}`);}
}

// Reference native background connector. No acceptance is inferred from documentation or a key's presence.
export class OpenAiResponsesAdapter extends HttpJsonAdapter {
 constructor(token:string,readonly modelName:string,profile:ProviderRuntimeProfile,endpoint='https://api.openai.com/v1',scopeHeaders:Record<string,string>={}){
  super('openai-responses',['text','qa'],endpoint,token,profile,scopeHeaders);if(!modelName)throw new Error('MODEL_REQUIRED');
 }
 async execute(task:ClaimedTask,signal:AbortSignal){
  if(task.risk!=='LOW'||task.payload?.verification!=='AGY_MISSION5'||typeof task.payload.prompt!=='string')throw new ConnectorError('PERMISSION_DENIED',false);
  if(task.payload.prompt.length>4096)throw new ConnectorError('INVALID_INPUT',false);
  const key=connectorIdempotencyKey(this.name,task),response=await this.call('/responses',{model:this.modelName,input:task.payload.prompt,background:true,max_output_tokens:128,
   metadata:{trace_id:task.taskId,job_id:task.jobId,task_id:task.taskId,attempt_id:task.leaseToken}},signal,key);
  if(typeof response.id!=='string')throw new ConnectorError('SUBMISSION_UNCERTAIN',false);
  return {externalId:response.id};
 }
 private normalize(response:any):ExecutionResult {
  const running=['queued','in_progress'].includes(response.status),succeeded=response.status==='completed';
  const text=response.output?.flatMap((item:any)=>item.content??[]).filter((c:any)=>c.type==='output_text').map((c:any)=>c.text).join('')??'';
  let output:Record<string,unknown>;try{output=JSON.parse(text);}catch{output={text};}
  return {state:running?'RUNNING':succeeded?'SUCCEEDED':response.status==='cancelled'?'CANCELLED':'FAILED',output,
   providerRequestId:response._agy_request_id,externalOperationId:response.id,model:response.model,providerUsage:response.usage,
   tokens:response.usage?.total_tokens,costAmount:undefined,providerQuotaRemaining:null,
   sharedResourcePoolId:this.runtimeProfile?.shared_resource_pool_id??undefined,
   error:!running&&!succeeded?{code:['insufficient_quota','credit_balance_exhausted'].includes(response.error?.code)?'PROVIDER_QUOTA_EXHAUSTED':'PROVIDER_FAILURE',message:'Provider operation not completed',retryable:false}:undefined};
 }
 async check_status(id:string){return this.normalize(await this.call('/responses/'+encodeURIComponent(id)));}
 async collect_result(id:string){return this.check_status(id);}
 async cancel(id:string){const response=await this.call('/responses/'+encodeURIComponent(id)+'/cancel',{});if(!['cancelled','completed','failed'].includes(response.status))throw new ConnectorError('CANCELLATION_UNCONFIRMED',false);}
 async usage(id:string){const r=await this.check_status(id);return {tokens:r.tokens,providerUsage:r.providerUsage,sharedResourcePoolId:r.sharedResourcePoolId,providerQuotaRemaining:null,costAmount:null};}
 async health(){try{await this.call('/models/'+encodeURIComponent(this.modelName));return {ready:true};}catch{return {ready:false,detail:'PROVIDER_AUTH_OR_MODEL_UNVERIFIED'};}}
}

async function pause(ms:number,signal:AbortSignal){await new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new ConnectorError('CONNECTOR_TIMEOUT',true));return;}const onAbort=()=>{clearTimeout(timer);reject(new ConnectorError('CONNECTOR_TIMEOUT',true));};const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},Math.max(0,ms));signal.addEventListener('abort',onAbort,{once:true});});}

export function configuredAdapters(env = process.env): WorkerAdapter[] {
  const definitions = [
    ["gemini", ["text", "planning", "qa"], env.GEMINI_ENDPOINT],
    ["muse", ["text", "creative"], env.MUSE_ENDPOINT],
    ["codex", ["code", "files", "cli"], env.CODEX_ENDPOINT],
    ["flow", ["video", "render"], env.FLOW_ENDPOINT],
  ] as const;
  return definitions.map(([name, capabilities, endpoint]) => endpoint ? new HttpJsonAdapter(name, [...capabilities], endpoint, env[`${name.toUpperCase()}_TOKEN`]) : new StubAdapter(name, [...capabilities]));
}

import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import type {ClaimedTask, ExecutionResult, WorkerAdapter} from '../types.js';
import {runtimeCapabilityAllows} from '../resources/allocation.js';
import {GatewayTransport, GatewayError, identity, type Lease, type Json} from './transport.js';
import {GatewayJournal, digest} from './journal.js';
import type {GatewayConfig} from './config.js';

export class GatewayShadowWorker {
  private busy = false;
  private heartbeatDue = 0;
  constructor(readonly gateway: GatewayTransport, readonly journal: GatewayJournal,
    readonly adapter: WorkerAdapter, readonly config: GatewayConfig) {}

  private task(lease: Lease): ClaimedTask {
    // The shadow payload is a TaskSpec envelope, not an arbitrary command or a source of identity.
    const spec = lease.payload;
    // The deployed claim API exposes neither prior checkpoints nor external-effect history.
    if (lease.attempt_no !== 1) throw new GatewayError('RECONCILIATION_REQUIRED');
    if (typeof spec.name !== 'string' || typeof spec.taskType !== 'string' ||
        spec.estimatedCost !== 0 || spec.permissionGranted !== true || spec.safetyApproved !== true || spec.risk !== 'LOW' ||
        (spec.requiredPermissions !== undefined && (!Array.isArray(spec.requiredPermissions) ||
          spec.requiredPermissions.some((p: string) => !['read','analyze','planning','qa'].includes(p)))) ||
        (spec.requiredCapabilities !== undefined && (!Array.isArray(spec.requiredCapabilities) ||
          spec.requiredCapabilities.some((c: string) => !this.adapter.capabilities.includes(c)))) ||
        /expert/i.test(String(spec.payload?.role ?? '')) || /openai-responses|expert/i.test(this.adapter.name) ||
        (spec.payload !== undefined && (!spec.payload || typeof spec.payload !== 'object' || Array.isArray(spec.payload))) ||
        (spec.timeoutSeconds !== undefined && (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1 || spec.timeoutSeconds > 3600)))
      throw new GatewayError('UNATTENDED_APPROVAL_BOUNDARY');
    const task = {...spec, name:spec.name,taskType:spec.taskType,idempotencyKey:lease.idempotency_key, taskId:lease.task_id,
      jobId:lease.mission_id, attempt:lease.attempt_no, status:'CLAIMED' as const, leaseToken:lease.lease_token,
      leaseExpiresAt:new Date(lease.expires_at), checkpoint:null,
      attemptId:lease.attempt_id,traceId:lease.trace_id,workerId:lease.worker_id,fence:lease.fence};
    if (!runtimeCapabilityAllows(this.adapter.runtimeProfile, task)) throw new GatewayError('RUNTIME_CAPABILITY_DENIED');
    return task;
  }
  private action(key: string, path: '/ack'|'/checkpoint'|'/result'|'/callback', lease: Lease, body: Json = {}) {
    return this.journal.once(key, {path,headers:identity(lease),body}, () => this.gateway.action(path,lease,body));
  }
  private async heartbeat(lease: Lease) {
    const body = {lease_seconds:this.config.leaseSeconds};
    const receipt = await this.journal.fresh('heartbeat', {headers:identity(lease),body}, () => this.gateway.action('/heartbeat',lease,body));
    lease.expires_at = receipt.expires_at;
    this.heartbeatDue = Date.now() + this.config.heartbeatMs;
  }
  // Await even slow connector operations while renewing the actual lease. No overlapping heartbeat writes.
  private async guarded<T>(operation: () => Promise<T>, lease: Lease, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new GatewayError('WORKER_STOPPED_OR_TIMEOUT');
    if (Date.now() >= this.heartbeatDue) await this.heartbeat(lease);
    const settled = operation().then(value => ({ok:true as const,value}), () => ({ok:false as const}));
    while (true) {
      const timer = new AbortController();
      const result = await Promise.race([settled, delay(Math.max(1,this.heartbeatDue-Date.now()), null,
        {signal:AbortSignal.any([signal,timer.signal])}).then(() => null).catch(() => null)]);
      timer.abort();
      if (signal.aborted) throw new GatewayError('WORKER_STOPPED_OR_TIMEOUT');
      if (result) {
        if (!result.ok) throw new GatewayError('CONNECTOR_OUTCOME_UNCERTAIN');
        return result.value;
      }
      await this.heartbeat(lease);
    }
  }
  async tick(signal: AbortSignal = new AbortController().signal): Promise<'IDLE'|'RESULT_SUBMITTED'> {
    if (this.busy) throw new GatewayError('WORKER_ALREADY_RUNNING');
    this.busy = true;
    const abort = new AbortController();
    try {
      this.journal.assertCertain(); await this.journal.next();
      if (signal.aborted) throw new GatewayError('WORKER_STOPPED');
      if ((await this.adapter.health()).ready !== true) throw new GatewayError('CONNECTOR_UNVERIFIED');
      await this.gateway.health();
      await this.journal.once('register', this.adapter.capabilities, () => this.gateway.register(this.adapter.capabilities));
      const lease = await this.journal.once('claim', {worker:this.gateway.workerId,leaseSeconds:this.config.leaseSeconds},
        () => this.gateway.claim(this.config.leaseSeconds));
      if (!lease) { await this.journal.complete(); return 'IDLE'; }
      const task = this.task(lease);
      const bounded = AbortSignal.any([signal, abort.signal, AbortSignal.timeout((task.timeoutSeconds ?? 300)*1000)]);
      // Confirmed ACK is replayed locally; the server's ACK is not assumed idempotent.
      await this.action('ack','/ack',lease);
      // After confirmed result the lease is released: recovery proceeds directly to callback.
      // Earlier completed receipts are replayed without contacting a released/expired lease.
      const effect = {adapter:this.adapter.name,digest:createHash('sha256').update(JSON.stringify(task.payload ?? {})).digest('hex'),
        idempotencyKey:lease.idempotency_key};
      const resultRequest = {effect,taskId:lease.task_id};
      let result = this.journal.receipt<{state:string;output:Json;externalId:string}>('execution-result',resultRequest);
      if (!result) {
        await this.heartbeat(lease);
        await this.action('checkpoint-intent','/checkpoint',lease,{version:1,state:{...effect,submissionState:'INTENT'}});
        task.checkpoint = {...effect,submissionState:'INTENT'};
        const submitted = await this.journal.once('external-submit', {effect,payload:task.payload}, async () => {
          const receipt = await this.guarded(() => this.adapter.execute(task,bounded),lease,bounded);
          if (!receipt || typeof receipt.externalId !== 'string' || !receipt.externalId.trim()) throw new GatewayError('SUBMISSION_UNCERTAIN');
          return receipt;
        });
        await this.action('checkpoint-accepted','/checkpoint',lease,{version:2,state:{...effect,externalId:submitted.externalId,submissionState:'ACCEPTED'}});
        let status: ExecutionResult;
        do {
          status = await this.guarded(() => this.adapter.check_status(submitted.externalId),lease,bounded);
          if (status.state === 'RUNNING') await this.guarded(() => delay(250),lease,bounded);
        } while (status.state === 'RUNNING');
        const collected = await this.guarded(() => this.adapter.collect_result(submitted.externalId),lease,bounded);
        if (!['SUCCEEDED','FAILED','CANCELLED'].includes(collected.state) || collected.state !== status.state)
          throw new GatewayError('RESULT_UNCONFIRMED');
        result = {state:collected.state,output:collected.output ?? {},externalId:submitted.externalId};
        await this.journal.remember('execution-result',resultRequest,result);
      }
      await this.action('result','/result',lease,{result_version:1,result_status:result.state === 'SUCCEEDED' ? 'RESULT_READY' : result.state,
        output:result.output,evidence:{external_operation_id:result.externalId,qa_state:'PENDING'}});
      const callbackId = 'CB-' + digest([lease.task_id,lease.attempt_id,1]);
      await this.action('callback','/callback',lease,{callback_id:callbackId,callback_status:'PENDING',
        target:'CHATGPT_ASSISTANT_CONTROL_PLANE',callback_payload:{event:'RESULT_READY',task_id:lease.task_id,
          attempt_id:lease.attempt_id,trace_id:lease.trace_id,result_state:result.state,qa_state:'PENDING'},
        evidence:{external_operation_id:result.externalId}});
      await this.journal.complete(); return 'RESULT_SUBMITTED';
    } finally { abort.abort(); this.busy = false; }
  }
}

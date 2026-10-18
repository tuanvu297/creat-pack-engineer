import {privateUrl} from './config.js';

export type Json = Record<string, any>;
export interface Lease {
  task_id: string; mission_id: string; attempt_id: string; attempt_no: number;
  idempotency_key: string; trace_id: string; worker_id: string; lease_token: string;
  fence: number; expires_at: string; payload: Json; acceptance_criteria: Json;
}
export class GatewayError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function identity(lease: Lease) {
  return Object.fromEntries(['task_id','attempt_id','idempotency_key','trace_id','worker_id','lease_token','fence']
    .map(k => ['x-agy-' + k.replaceAll('_','-'), String((lease as any)[k])]));
}
function object(value: any): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }

// No DB client, auth key, redirect following or transport retry belongs on this side of the boundary.
export class GatewayTransport {
  readonly url: string;
  constructor(url: string, readonly workerId: string, readonly timeoutMs = 5000) { this.url = privateUrl(url); }
  async health() {
    let r: any;
    try {
      const res = await fetch(this.url + '/health',{redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
      if (!res.ok) throw new Error();
      r = await res.json();
    } catch { throw new GatewayError('GATEWAY_HEALTH_UNVERIFIED'); }
    if (r.gateway !== 'PASS' || r.canonical_authority !== 'EXISTING_POSTGRES_D049' ||
        r.state_plane?.status !== 'PASS' || r.state_plane.mode !== 'SHADOW_STAGING' ||
        r.state_plane.canonical_authority !== 'EXISTING_POSTGRES_D049') throw new GatewayError('GATEWAY_AUTHORITY_MISMATCH');
  }
  private async post(path: string, body: Json, headers: Record<string,string> = {}): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(this.url + path, {method:'POST', redirect:'error', signal:AbortSignal.timeout(this.timeoutMs),
        headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(body)});
    } catch { throw new GatewayError('GATEWAY_OUTCOME_UNCERTAIN'); }
    if (!response.ok) throw new GatewayError(response.status >= 500 ? 'GATEWAY_OUTCOME_UNCERTAIN' : 'GATEWAY_REJECTED');
    let data: unknown;
    try { data = await response.json(); } catch { throw new GatewayError('GATEWAY_OUTCOME_UNCERTAIN'); }
    if (!object(data)) throw new GatewayError('GATEWAY_RESPONSE_INVALID');
    return data;
  }
  async register(capabilities: string[]) {
    const r = await this.post('/workers/register', {worker_id:this.workerId, provider:'R11', role:'WORKER', capabilities,
      permissions:['read','analyze','planning','qa']});
    if (r.status !== 'PASS' || r.worker_id !== this.workerId || r.health !== 'ONLINE') throw new GatewayError('REGISTER_UNCONFIRMED');
    return r;
  }
  async createTask(body: Json) {
    const r = await this.post('/tasks/create', body);
    if (!['CREATED','IDEMPOTENT_REPLAY'].includes(r.status) ||
        ['task_id','mission_id','trace_id'].some(k => !body[k] || r[k] !== body[k])) throw new GatewayError('CREATE_UNCONFIRMED');
    return r;
  }
  async claim(leaseSeconds: number): Promise<Lease|null> {
    const r = await this.post('/tasks/claim', {provider:'R11', role:'WORKER', lease_seconds:leaseSeconds}, {'x-agy-worker-id':this.workerId});
    if (r.status === 'EMPTY') return null;
    // Queue maintenance responses are observations, never fabricated claims or IDLE receipts.
    if (r.status !== 'LEASED') throw new GatewayError('CLAIM_NOT_LEASED');
    if (['task_id','mission_id','attempt_id','idempotency_key','trace_id','worker_id','lease_token'].some(k =>
        typeof r[k] !== 'string' || !r[k].trim() || /[\r\n]/.test(r[k])) || r.worker_id !== this.workerId ||
        !Number.isSafeInteger(r.fence) || r.fence < 1 || !Number.isSafeInteger(r.attempt_no) || r.attempt_no < 1 ||
        !Number.isFinite(Date.parse(r.expires_at)) || Date.parse(r.expires_at) <= Date.now() || !object(r.payload))
      throw new GatewayError('LEASE_CONTRACT_INVALID');
    return r as Lease;
  }
  async action(path: '/ack'|'/heartbeat'|'/checkpoint'|'/result'|'/callback', lease: Lease, body: Json = {}) {
    const r = await this.post(path, body, identity(lease));
    const allowed: Record<string,string[]> = {'/ack':['ACKED'], '/heartbeat':['RUNNING','CHECKPOINTED'],
      '/checkpoint':['CHECKPOINTED'], '/result':['RESULT_SUBMITTED'], '/callback':['PENDING']};
    if (!allowed[path].includes(r.status) || r.task_id !== lease.task_id || r.attempt_id !== lease.attempt_id ||
        (path !== '/result' && path !== '/callback' && r.fence !== lease.fence) ||
        (path === '/checkpoint' && r.version !== body.version) ||
        (path === '/result' && (r.result_version !== body.result_version || r.result_status !== body.result_status)) ||
        (path === '/callback' && r.callback_id !== body.callback_id) ||
        (path === '/heartbeat' && (!Number.isFinite(Date.parse(r.expires_at)) || Date.parse(r.expires_at) <= Date.now())))
      throw new GatewayError('ACTION_UNCONFIRMED');
    return r;
  }
}

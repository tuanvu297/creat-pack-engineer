import type { Pool } from 'pg';
import { authorize,type Principal } from './auth.js';
import { ProjectPool } from './scoped-pool.js';
import { validateScope,type ProjectScope } from './scope.js';
import { PostgresStore } from '../postgres-store.js';
import { routeTasks } from '../scheduler.js';
import type { TaskSpec,ScheduleMode } from '../types.js';
import { operationsApi } from '../operations-api.js';
import { connectorAdapter,type ConnectorBinding } from './connectors.js';
import { runtimeStatus } from './runtime-status.js';
export class ProjectService {
 readonly scope:ProjectScope;readonly pool:Pool;readonly store:PostgresStore;
 constructor(private readonly raw:Pool,scope:ProjectScope,readonly principal:Principal) {
  this.scope=validateScope(scope);authorize(principal,this.scope,'read');
  this.pool=new ProjectPool(raw,this.scope,principal.subject).asPool();this.store=new PostgresStore(this.pool,this.scope);
 }
 async execute(path:string,method:string,body:any={}) {
  const action=method==='GET'?'read':path.startsWith('/approvals/')?'approve':path.startsWith('/qa/')?'qa':'write';
  authorize(this.principal,this.scope,action);
  if(path==='/runtime/status'&&method==='GET')return runtimeStatus(this.pool);
  for(const key of ['tenant_id','workspace_id','project_id','tenantId','workspaceId','projectId'])if(key in body)throw new Error('BODY_SCOPE_OVERRIDE_DENIED');
  if(path==='/global-skills'&&method==='GET')return (await this.raw.query('SELECT skill_id,content,report_fingerprint,approved_at FROM agy_global_skills ORDER BY skill_id')).rows;
  if(path==='/project'&&method==='GET')return (await this.pool.query('SELECT * FROM agy_projects')).rows[0];
  if(path==='/jobs'&&method==='POST') {
   if(typeof body.idempotency_key!=='string'||!body.idempotency_key||typeof body.objective!=='string'||!Array.isArray(body.tasks)||!body.tasks.length)throw new Error('INVALID_JOB');
   const project=(await this.pool.query('SELECT * FROM agy_projects')).rows[0];if(!project||project.status!=='ACTIVE')throw new Error('PROJECT_NOT_ACTIVE');
   const tasks=body.tasks as TaskSpec[];
   for(const task of tasks)if((task.requiredPermissions??[]).some(p=>!project.permissions.includes(p)))throw new Error('PROJECT_PERMISSION_DENIED');
   const routing=routeTasks(tasks,body.mode as ScheduleMode|undefined);
   return {...await this.store.createJob({tenantId:this.scope.tenantId,idempotencyKey:body.idempotency_key,objective:body.objective,mode:routing.mode,passThreshold:body.pass_threshold??.8,tasks:routing.tasks,deadlineMs:typeof body.deadline_ms==='number'?body.deadline_ms:undefined}),routing:routing.rationale};
  }
  const job=/^\/jobs\/([a-f0-9-]{36})$/.exec(path);
  if(job&&method==='GET') {const row=(await this.pool.query('SELECT * FROM agy_jobs WHERE job_id=$1',[job[1]])).rows[0];return row?{job:row,tasks:(await this.pool.query('SELECT * FROM agy_tasks WHERE job_id=$1',[job[1]])).rows}:undefined;}
  if(path==='/artifacts'&&method==='GET')return (await this.pool.query('SELECT * FROM agy_artifacts ORDER BY created_at DESC LIMIT 100')).rows;
  if(path==='/artifacts'&&method==='POST') {
   if(typeof body.uri!=='string'||!body.uri.startsWith('artifact://'))throw new Error('PROJECT_ARTIFACT_URI_REQUIRED');
   return (await this.pool.query('INSERT INTO agy_artifacts(job_id,task_id,uri,metadata) VALUES($1,$2,$3,$4) RETURNING *',[body.job_id,body.task_id??null,body.uri,body.metadata??{}])).rows[0];
  }
  if(path==='/telemetry'&&method==='GET')return (await this.pool.query('SELECT * FROM agy_telemetry ORDER BY created_at DESC LIMIT 100')).rows;
  if(path==='/logs'&&method==='GET')return (await this.pool.query('SELECT * FROM agy_task_events ORDER BY created_at DESC LIMIT 100')).rows;
  if(path==='/qa/results'&&method==='GET')return (await this.pool.query('SELECT * FROM agy_qa_results ORDER BY created_at DESC LIMIT 100')).rows;
  if(path==='/qa/results'&&method==='POST')return (await this.pool.query('INSERT INTO agy_qa_results(task_id,job_id,verdict,evidence,reviewed_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[body.task_id,body.job_id,body.verdict,body.evidence,this.principal.subject])).rows[0];
  if(path==='/connectors'&&method==='GET')return (await this.pool.query('SELECT connector_id,kind,capabilities,enabled,permissions FROM agy_connectors')).rows;
  if(path.startsWith('/learning')||path.startsWith('/approvals'))return operationsApi('/v1'+path,method,body,this.pool,action==='approve'?this.principal.subject:undefined,true);
  if(path==='/maintenance/reclaim'&&method==='POST')return {reclaimed:await this.store.reclaimExpired()};
  return undefined;
 }
 async adapter(connectorId:string) {
  authorize(this.principal,this.scope,'execute');
  const r=(await this.pool.query('SELECT * FROM agy_connectors WHERE connector_id=$1',[connectorId])).rows[0];if(!r)throw new Error('CONNECTOR_SCOPE_DENIED');
  const project=(await this.pool.query('SELECT policies FROM agy_projects')).rows[0];
  const binding:ConnectorBinding={...this.scope,connectorId:r.connector_id,kind:r.kind,capabilities:r.capabilities,endpoint:r.endpoint,secretRef:r.secret_ref,enabled:r.enabled,permissions:r.permissions,runtimeProfile:project?.policies?.connectorRuntimeProfiles?.[connectorId]};
  if(!/^AGY_SECRET_[A-Z0-9_]+$/.test(binding.secretRef))throw new Error('INVALID_SECRET_REF');
  return connectorAdapter(binding,ref=>process.env[ref]);
 }
}

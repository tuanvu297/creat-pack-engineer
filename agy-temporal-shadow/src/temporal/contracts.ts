import type { ProjectScope } from '../platform/scope.js';
export const QA_CONTRACT_VERSION = '1.1';
export interface Mission extends ProjectScope {
  mission_id: string; task_id: string; attempt: number; idempotency_key: string;
  objective: string; executor_worker_id: string; source_ref: string;
  qa_contract_version: '1.1'; mode: 'TEMPORAL_SHADOW';
  payload: Record<string, unknown>; ack_timeout_ms: number; result_timeout_ms: number;
  qa_timeout_ms: number; max_corrections: number;
}
export interface Binding {workflow_id:string;run_id:string;job_id:string;db_task_id:string;lease_token:string;attempt:number;lease_attempt:number}
export interface WorkerReceipt {task_id:string;attempt:number;idempotency_key:string;executor_worker_id:string;operation_id:string}
export interface QaVerdict {reviewer_id:string;verdict:'PASS'|'FAIL';evidence_refs:string[];corrective_instruction?:string;qa_contract_version:'1.1';attempt:number}
export interface Snapshot {state:string;qa_state:string;attempt:number;operation_id?:string;evidence_refs?:string[];reason?:string}
export interface Activities {
  load_project_state(m:Mission,workflow_id:string,run_id:string):Promise<Binding>;
  dispatch_worker(m:Mission,b:Binding):Promise<{state:'ACKED'|'UNCERTAIN'|'BLOCKED_ROUTE';receipt?:WorkerReceipt}>;
  record_executor_ack(m:Mission,b:Binding,r:WorkerReceipt):Promise<void>;
  heartbeat_checkpoint(m:Mission,b:Binding):Promise<Binding>;
  submit_result_evidence(m:Mission,b:Binding):Promise<{state:'RUNNING'|'RESULT'|'UNCERTAIN';evidence_refs?:string[]}>;
  wait_result_event(m:Mission,b:Binding):Promise<{binding:Binding;result:{state:'RUNNING'|'RESULT'|'UNCERTAIN';evidence_refs?:string[]}}>;
  reconcile_uncertain_operation(m:Mission,b:Binding):Promise<{state:'ACKED'|'BLOCKED';receipt?:WorkerReceipt}>;
  submit_qa_verdict(m:Mission,b:Binding,q:QaVerdict):Promise<{state:'COMPLETE'|'CORRECT'|'BLOCKED'}>;
  write_callback_receipt(m:Mission,b:Binding,state:string,reason?:string):Promise<void>;
  prepare_correction(m:Mission,b:Binding,q:QaVerdict):Promise<Binding>;
}

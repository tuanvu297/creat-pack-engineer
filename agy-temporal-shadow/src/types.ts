export type ScheduleMode = "SINGLE_WORKFLOW" | "PARALLEL_BATCH" | "DAG" | "MULTI_JOB_CONCURRENT";
export type TaskStatus = "QUEUED" | "CLAIMED" | "RUNNING" | "QA" | "PASS" | "FAIL" | "RETRY" | "BLOCKED" | "CANCELLED";
export type CapabilitySupport = 'SUPPORTED'|'UNSUPPORTED'|'UNVERIFIED';
export type ConnectorClass = 'VERIFICATION_ONLY'|'LIMITED_STAGING'|'ACCEPTED_STAGING';
export type RuntimeCapability = 'supports_status'|'supports_collect'|'supports_remote_cancel'|'supports_native_idempotency'|'supports_resume'|'supports_usage'|'supports_cost'|'supports_quota_remaining'|'supports_retry_after'|'supports_background';
export interface ProviderRuntimeProfile extends Record<RuntimeCapability,CapabilitySupport> {
  provider:string;connector_id:string;credential_scope_class:'ACCOUNT_LOGIN'|'STAGING_SERVICE'|'UNKNOWN';
  execution_mode:'sync'|'async'|'background';shared_resource_pool_id:string|null;
  model:string|null;requested_model?:string;version:string|null;capability_snapshot_version:string;
  health_freshness:{observed_at:number;max_age_ms:number};risk_constraints:('LOW'|'MEDIUM'|'HIGH')[];
  classification:ConnectorClass;core_evidence_ref:string|null;
  submission_replay:'DURABLE_GATEWAY'|'NATIVE_PROVEN'|'BLOCK_ON_UNCERTAINTY';
}

export interface TaskSpec {
  idempotencyKey: string;
  name: string;
  taskType: string;
  payload?: Record<string, unknown>;
  requiredCapabilities?: string[];
  dependsOn?: string[];
  priority?: number;
  maxRetry?: number;
  timeoutSeconds?: number;
  risk?: "LOW" | "MEDIUM" | "HIGH";
  deterministic?: boolean;
  importance?: number;
  expectedValue?: number;
  estimatedQuota?: number;
  estimatedCost?: number;
  requiredPermissions?: string[];
  promptVersion?: string;
  sharedStateKey?: string;
  permissionGranted?: boolean;
  safetyApproved?: boolean;
  submissionGeneration?: number;
  requiredRuntimeCapabilities?:RuntimeCapability[];
  minimumConnectorClass?:ConnectorClass;
}

export interface ClaimedTask extends TaskSpec {
  taskId: string;
  jobId: string;
  status: TaskStatus;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  passThreshold?: number;
  checkpoint?: { externalId?: string; digest: string; adapter: string;submissionState?:'INTENT'|'ACCEPTED';idempotencyKey?:string } | null;
}

export interface ExecutionResult {
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
  model?: string;
  tool?: string;
  costAmount?: number|null;
  costCurrency?: string;
  quotaUnits?: number;
  tokens?: number;
  contextLoss?: boolean;
  externalOperationId?:string;
  sharedResourcePoolId?:string;
  providerUsage?:Record<string,unknown>;
  providerRequestId?:string;
  providerExecutionLatencyMs?:number;
  providerQuotaRemaining?:number|null;
  qa?: QaEvidence;
}

export interface QaEvidence {
  deterministicPassed: boolean;
  score: number;
  checkerPassed?: boolean;
  independentPassed?: boolean;
  finalJudgmentPassed?: boolean;
  confidence: number;
  conflict?: boolean;
  evidenceSufficient: boolean;
  feedback?: string[];
  humanCorrection?: string;
}

export interface WorkerAdapter {
  readonly name: string;
  readonly capabilities: string[];
  readonly runtimeProfile?:ProviderRuntimeProfile;
  execute(task: ClaimedTask, signal: AbortSignal): Promise<{ externalId: string }>;
  check_status(externalId: string): Promise<ExecutionResult>;
  cancel(externalId: string): Promise<void>;
  collect_result(externalId: string): Promise<ExecutionResult>;
  health(): Promise<{ ready: boolean; detail?: string }>;
  usage?(externalId:string):Promise<{tokens?:number;quotaUnits?:number;costAmount?:number|null;providerUsage?:Record<string,unknown>;sharedResourcePoolId?:string}>;
}

export interface ClaimRequest { workerId: string; capabilities: string[]; leaseSeconds: number }

export interface EngineStore {
  createJob(input: { tenantId: string; idempotencyKey: string; objective: string; mode: ScheduleMode; passThreshold: number; tasks: TaskSpec[] }): Promise<{ jobId: string; duplicate: boolean }>;
  claim(request: ClaimRequest): Promise<ClaimedTask | null>;
  heartbeat(taskId: string, workerId: string, leaseToken: string, leaseSeconds: number): Promise<boolean>;
  transition(taskId: string, leaseToken: string, from: TaskStatus[], to: TaskStatus, patch?: Record<string, unknown>): Promise<boolean>;
  reclaimExpired(): Promise<number>;
  recordTelemetry(input: Record<string, unknown>): Promise<void>;
  saveCheckpoint?(task: ClaimedTask, externalId: string, adapter: string): Promise<void>;
  saveSubmissionIntent?(task:ClaimedTask,adapter:string,idempotencyKey:string):Promise<void>;
  deferTask?(task:ClaimedTask,workerId:string,retryAfterMs:number,code:string):Promise<boolean>;
  recordWorkerFailure?(workerId: string, code: string, attempt: number, maxRetry: number): Promise<void>;
}

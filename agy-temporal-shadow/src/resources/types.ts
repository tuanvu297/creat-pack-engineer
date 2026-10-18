import type { WorkerProfile } from "../scheduler.js";
import type { ProviderRuntimeProfile } from '../types.js';
export type ResourceStatus = "READY" | "BUSY" | "DEGRADED" | "RATE_LIMITED" | "OFFLINE";
export type ReservePurpose = "RETRY" | "RECOVERY" | "HIGH_PRIORITY" | "FINAL_QA" | "UNEXPECTED";
export interface Resource extends WorkerProfile {
  runtimeProfile?:ProviderRuntimeProfile;
  sharedPoolAllowance?:{quotaCap:number;spendCap:number;maxConcurrency:number};
  model?: string;
  status: ResourceStatus;
  permissions: string[];
  lastHealthAt: number;
  rateLimitedUntil: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  spendUsed: number;
  spendCap: number | null;
  quotaUsed: number;
  quotaCap: number | null;
  reservedQuota: number;
  reserveByPurpose: Record<ReservePurpose, number>;
  version: number;
}
export interface AttemptUsage {
  attemptId: string; taskId: string; jobId: string; workerId: string;
  taskType: string; model?: string; tool?: string; promptVersion: string;
  tokens?: number; credit?: number; cost?: number; latencyMs: number;
  outcome: "PASS" | "FAIL" | "BLOCKED" | "QA_PENDING";
  retry: number; errorType?: string; qaResult?: string; humanCorrection?: string;
  contextLoss?: boolean; finalOutcome?: string;
}
export interface Reservation {
  reservationId: string; attemptId: string; workerId: string; quota: number;
  cost: number; purpose?: ReservePurpose; expiresAt: number;
  state: "HELD" | "SETTLED" | "EXPIRED";
  actualQuota?: number; actualCost?: number;
}
export interface ResourceState { resources: Resource[]; reservations: Reservation[]; usage: AttemptUsage[] }

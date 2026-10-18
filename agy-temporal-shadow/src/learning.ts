export interface LearningSample {
  taskType: string; workerId: string; model?: string; tool?: string; promptVersion: string;
  finalOutcome: "PASS" | "FAIL" | "BLOCKED"; retry: number; errorType?: string;
  latencyMs: number; quotaUnits?: number; costAmount?: number;
  humanCorrection?: string; qaFeedback: string[];
}
export interface CandidateMetrics { passRate: number; throughput: number; usefulUtilization: number; centralLoad: number; retryRate: number; contextLossRate: number; costPerPass: number; stability: number }
export function compareCandidate(candidateId: string, baseline: CandidateMetrics, candidate: CandidateMetrics, sampleCount: number, passThreshold: number) {
  const score = (m:CandidateMetrics) => m.throughput + m.usefulUtilization + 4*m.passRate - m.centralLoad - m.retryRate - m.contextLossRate - m.costPerPass;
  const sufficient = sampleCount >= 30 && candidate.passRate >= passThreshold && candidate.stability >= baseline.stability;
  return { candidateId, stage: "REPORT" as const, baseline, candidate, sampleCount, sufficientEvidence: sufficient,
    outperformsBaseline: sufficient && score(candidate) > score(baseline),
    nextAction: sufficient && score(candidate) > score(baseline) ? "USER_APPROVAL_REQUIRED" : "COLLECT_EVIDENCE_OR_REJECT",
    promoted: false, policy: "CANDIDATE → TEST → COMPARE WITH BASELINE → COLLECT EVIDENCE → REPORT → USER APPROVAL → PROMOTE or REJECT" };
}
export function competencyProfile(samples: LearningSample[]) {
  return { sampleCount: samples.length, passRate: samples.length ? samples.filter(s=>s.finalOutcome==="PASS").length/samples.length : null,
    retryRate: samples.length ? samples.filter(s=>s.retry>0).length/samples.length : null,
    proposalOnly: true, targets: ["routing", "retry", "qa", "prompt/playbook", "Skill Library", "Skill Pack"] };
}

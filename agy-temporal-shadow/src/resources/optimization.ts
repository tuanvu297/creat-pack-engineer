import { compareCandidate, type CandidateMetrics } from "../learning.js";
// Policy comparison creates evidence proposals; Resource Manager does not learn/promote skills.
export function compareWorkerStrategies(baseline: CandidateMetrics, candidate: CandidateMetrics, samples:number, threshold:number) {
  return compareCandidate("worker-strategy",baseline,candidate,samples,threshold);
}

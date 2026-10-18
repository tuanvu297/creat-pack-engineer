import type { QaEvidence, TaskSpec } from "./types.js";
export function qaPolicy(task: TaskSpec, evidence?: QaEvidence): "DETERMINISTIC" | "CHECKER" | "INDEPENDENT_AND_JUDGMENT" {
  if (task.risk === "HIGH" || evidence?.conflict || (evidence && (evidence.confidence < .8 || !evidence.evidenceSufficient))) return "INDEPENDENT_AND_JUDGMENT";
  return task.risk === "LOW" && task.deterministic ? "DETERMINISTIC" : "CHECKER";
}
export function evaluateQa(task: TaskSpec, evidence: QaEvidence | undefined, threshold: number): "PASS" | "FAIL" | "PENDING" {
  if (!evidence) return "PENDING";
  if (!evidence.deterministicPassed || evidence.score < threshold) return "FAIL";
  if (evidence.conflict || !evidence.evidenceSufficient) return "PENDING";
  const policy = qaPolicy(task, evidence);
  if (policy === "CHECKER") return evidence.checkerPassed === undefined ? "PENDING" : evidence.checkerPassed ? "PASS" : "FAIL";
  if (policy === "INDEPENDENT_AND_JUDGMENT") {
    if (evidence.independentPassed === false || evidence.finalJudgmentPassed === false) return "FAIL";
    return evidence.independentPassed && evidence.finalJudgmentPassed ? "PASS" : "PENDING";
  }
  return "PASS";
}

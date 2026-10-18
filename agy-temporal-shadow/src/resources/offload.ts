import type { Demand } from "./demand.js";
const highValue = new Set(["strategy","architecture","orchestration","difficult_reasoning","conflict_resolution","final_judgment","difficult_qa","high_risk_qa"]);
export function offloadPolicy(demand: Demand) {
  return { preferCentral:highValue.has(demand.taskType), offload:!highValue.has(demand.taskType),
    reason:highValue.has(demand.taskType)?"Retain high-value reasoning/judgment capacity":"Use capable worker for bulk/repetitive/deterministic execution" };
}

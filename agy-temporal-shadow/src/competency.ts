import type { LearningSample } from "./learning.js";
export function competencyByTask(samples:LearningSample[]) {
  const groups=new Map<string,LearningSample[]>();
  for(const s of samples){const key=JSON.stringify([s.workerId,s.model??"unknown",s.taskType,s.promptVersion]);groups.set(key,[...(groups.get(key)??[]),s]);}
  return [...groups.entries()].map(([key,rows])=>({key:JSON.parse(key),sampleCount:rows.length,
    passRate:rows.filter(s=>s.finalOutcome==="PASS").length/rows.length,
    retryRate:rows.filter(s=>s.retry>0).length/rows.length,
    observedCost:rows.some(s=>s.costAmount!==undefined)?rows.reduce((n,s)=>n+(s.costAmount??0),0):null,
    correctionRate:rows.filter(s=>s.humanCorrection).length/rows.length,
    confidence:Math.min(.95,rows.length/100),capabilitiesAreObservations:true,notPermanent:true}));
}

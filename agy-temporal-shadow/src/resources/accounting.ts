import type { AttemptUsage } from "./types.js";
export function accountingMetrics(usage: AttemptUsage[]) {
  const final=usage.filter(s=>s.finalOutcome!==undefined);
  return { attempts:usage.length, passRate:final.length?final.filter(s=>s.finalOutcome==="PASS").length/final.length:null,
    tokens:usage.some(s=>s.tokens!==undefined)?usage.reduce((n,s)=>n+(s.tokens??0),0):null,
    cost:usage.some(s=>s.cost!==undefined)?usage.reduce((n,s)=>n+(s.cost??0),0):null,
    credit:usage.some(s=>s.credit!==undefined)?usage.reduce((n,s)=>n+(s.credit??0),0):null,
    retryRate:usage.length?usage.filter(s=>s.retry>0).length/usage.length:null,
    contextLossRate:usage.some(s=>s.contextLoss!==undefined)?usage.filter(s=>s.contextLoss).length/usage.filter(s=>s.contextLoss!==undefined).length:null };
}

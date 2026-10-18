// No provider request is sent by this preflight. A configured key alone cannot prove acceptance.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const approved=process.env.AGY_OPENAI_STAGING_APPROVED==='true',present=!!process.env.AGY_SECRET_OPENAI_STAGING;
const evidence={phase:10,status:approved&&present?'PENDING_LIVE_ACCEPTANCE':'BLOCKED_CREDENTIAL',provider:'OpenAI Responses reference candidate',
 secretVariable:'AGY_SECRET_OPENAI_STAGING',credentialPresent:present,stagingApprovalDeclared:approved,
 modelConfigured:!!process.env.AGY_OPENAI_MODEL,budgetConfigured:!!process.env.AGY_MISSION5_COST_ALLOWANCE,
 providerRequestsSent:0,acceptedStagingConnectorCount:0,credentialBoundaryPass:false,
 note:'Presence/approval declaration is not credential-scope or execution proof. No account login substituted. No production gateway invoked.'};
const out=resolve('../agy-mission5-evidence');await mkdir(out,{recursive:true});await writeFile(resolve(out,'MISSION5-LIVE-PREFLIGHT.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
process.exitCode=approved&&present?0:78;

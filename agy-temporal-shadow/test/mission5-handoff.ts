// Sanitized artifact generation only; no provider/DB access or credential reads.
import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
const source=resolve('.'),evidence=resolve('../agy-mission5-evidence'),baseline=resolve('../../work/mission5/synced-sprint4/agy-worker-engine-v1');
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function files(root:string):Promise<string[]>{const out:string[]=[];for(const d of await readdir(root,{withFileTypes:true})){if(['node_modules','.git','.env'].includes(d.name)||d.isSymbolicLink())continue;const p=resolve(root,d.name);if(d.isDirectory())out.push(...await files(p));else if(d.isFile())out.push(p);}return out;}
const sourceHashes=[];const changed=[];
for(const path of await files(source)){const name=relative(source,path).replaceAll('\\','/'),current=sha(await readFile(path));sourceHashes.push({path:name,sha256:current});let old:string|null=null;try{old=sha(await readFile(resolve(baseline,name)));}catch{}if(old!==current)changed.push({path:name,baselineSha256:old,currentSha256:current});}
for(const migration of sourceHashes.filter(x=>/^migrations\/00[1-6]_/.test(x.path))){if(sha(await readFile(resolve(baseline,migration.path)))!==migration.sha256)throw Error('BASELINE_MIGRATION_CHANGED');}
const prior=resolve('../../work/mission5/SPRINT4-FROM-DRIVE.zip'),priorHash=sha(await readFile(prior));
if(priorHash!=='53b9f5f567d50787966672ddd6fa477b508c4ade73afc8abdb4615ac2f83a3e1')throw Error('DRIVE_BASELINE_HASH_CHANGED');
const gates={DATA_ISOLATION_PASS:true,RECOVERY_PASS:true,PLATFORM_CORE_VERIFIED:true,CONNECTOR_CORE_PASS:false,CREDENTIAL_BOUNDARY_PASS:false,CRASH_RECOVERY_PASS:false,ACCOUNTING_PASS:false,CAPABILITY_ROUTING_PASS:true,
 REMOTE_CANCEL:'UNVERIFIED',NATIVE_IDEMPOTENCY:'UNVERIFIED',RATE_LIMIT_EVIDENCE:'PARTIAL',ACCEPTED_STAGING_CONNECTOR_COUNT:0,MULTI_PROVIDER_ROUTING_VERIFIED:false,
 AGY_PLATFORM_STAGING_READY:false,AGY_PLATFORM_MULTI_PROVIDER_READY:false,AGY_PLATFORM_PRODUCTION_READY:false,LIVE_CONNECTOR_PASS:false,AGY_PLATFORM_READY:false};
const capability={snapshotVersion:'MISSION5-1',notAReadyRegistryConfiguration:true,candidates:[
 {provider:'OpenAI/Codex CLI',connectorId:'sprint4-codex',credential_scope_class:'ACCOUNT_LOGIN',classification:'VERIFICATION_ONLY',execution_mode:'async',shared_resource_pool_id:'codex-chatgpt-account-sprint4',model:null,version:null,
  status:'SUPPORTED_APPLICATION_GATEWAY',collect:'SUPPORTED_APPLICATION_GATEWAY',resume:'SUPPORTED_APPLICATION_GATEWAY',usage:'VERIFIED_HISTORICAL_TOKENS',remote_cancel:'UNVERIFIED',native_idempotency:'UNVERIFIED',background:'UNVERIFIED',cost:null,quota_remaining:null,retry_after:'CONTROLLED_APPLICATION_ONLY',freshHealthObservation:null,risk_constraints:['LOW']},
 {provider:'OpenAI Responses',connectorId:'mission5-reference',credential_scope_class:'UNKNOWN',classification:'VERIFICATION_ONLY',execution_mode:'async',shared_resource_pool_id:null,model:null,version:null,
  status:'UNVERIFIED_NATIVE',collect:'UNVERIFIED_NATIVE',resume:'UNVERIFIED_NATIVE',usage:'UNVERIFIED_NATIVE',remote_cancel:'UNVERIFIED',native_idempotency:'UNVERIFIED',background:'UNVERIFIED_NATIVE',cost:null,quota_remaining:null,retry_after:'CONTROLLED_APPLICATION_ONLY',freshHealthObservation:null,risk_constraints:['LOW','SYNTHETIC_TEXT_ONLY','NO_TOOLS','NO_PRODUCTION']}],acceptedCount:0};
await writeFile(resolve(evidence,'MISSION5-CONNECTOR-CAPABILITY-MATRIX.json'),JSON.stringify(capability,null,2));
const controlled=JSON.parse(await readFile(resolve(evidence,'MISSION5-CONTROLLED-PG-EVIDENCE.json'),'utf8'));
const preflight=JSON.parse(await readFile(resolve(evidence,'MISSION5-LIVE-PREFLIGHT.json'),'utf8'));
const learning=JSON.parse(await readFile(resolve(evidence,'MISSION5-PROJECT-LEARNING.json'),'utf8'));
const result=await readFile(resolve(evidence,'MISSION5-TEST-RESULTS.txt'),'utf8');
if(!/tests 81/.test(result)||!/pass 81/.test(result)||!/fail 0/.test(result)||!/skipped 0/.test(result))throw Error('REGRESSION_NOT_EXPECTED_PASS');
const manifest={status:'BLOCKED_CREDENTIAL',date:'2026-10-09',environment:{postgresql:'17.11 disposable loopback',node:'24.19.0',productionAccess:false},
 provenance:{driveFileId:'11vpbrZ8AhYKNpfD_Z18XfGeeH88ntjit',size:(await stat(prior)).size,sha256:priorHash,baselineSourceFilesCompared:73,differencesBeforeMission5:0,migrations001to006Unchanged:true},
 gates,applicationOnlyChecks:{crashSafety:true,accounting:true},regression:{tests:81,pass:81,fail:0,skip:0,typecheck:'PASS'},
 providerRequestsSentMission5:0,exactlyOnceProviderExecutionClaimed:false,controlled,preflight,learning,
 requiredLiveAcceptance:{status:'BLOCKED',unexecuted:['dedicated credential validation','native scoped end-to-end','native process restart/recovery','native usage/accounting reconciliation','native rate limit observation','active native cancellation if required']},
 sourceHashes,changedFiles:changed,preservedIntermediateFailures:(await files(evidence)).filter(x=>/INTERMEDIATE/.test(x)).map(x=>relative(evidence,x)),
 sourceDocumentation:'MISSION5-REPORT.md',runbook:'MISSION5-RUNBOOK.md',secretsIncluded:false};
await writeFile(resolve(evidence,'MISSION5-EVIDENCE.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({status:manifest.status,sourceFiles:sourceHashes.length,changedFiles:changed.length,migrations001to006Unchanged:true,regression:manifest.regression,gates}));

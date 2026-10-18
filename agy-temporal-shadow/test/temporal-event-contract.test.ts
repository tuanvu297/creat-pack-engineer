import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMission} from '../src/temporal/bridge.js';
import {temporalConfig} from '../src/temporal/config.js';
import type {Mission} from '../src/temporal/contracts.js';
const m:Mission={tenantId:'gl',workspaceId:'legacy-workspace',projectId:'GL_AUTOMATION',mission_id:'AGY-TEMPORAL-20261018',task_id:'bounded-command',attempt:1,idempotency_key:'contract-only',objective:'Contract validation only',executor_worker_id:'CODEX_ENGINEERING_COMMAND',source_ref:'contract-test',qa_contract_version:'1.1',mode:'TEMPORAL_SHADOW',payload:{command:'verify_gateway_contract'},ack_timeout_ms:60000,result_timeout_ms:60000,qa_timeout_ms:60000,max_corrections:0};
test('native lane rejects caller commands, args, other missions, and automatic corrections',()=>{
 assert.doesNotThrow(()=>validateMission(m));
 for(const change of [{payload:{command:'powershell'}},{payload:{command:'verify_gateway_contract',argv:['anything']}},{mission_id:'OTHER'},{max_corrections:1}])assert.throws(()=>validateMission({...m,...change}),/NATIVE_COMMAND_SCOPE_DENIED/);
});
test('native contract rejects invalid timeouts and altered submission attempts',()=>{
 for(const change of [{attempt:2},{ack_timeout_ms:NaN},{result_timeout_ms:Infinity},{qa_timeout_ms:0}])assert.throws(()=>validateMission({...m,...change}),/INVALID_MISSION/);
});
test('LEGACY stays default and remote Temporal address stays rejected',()=>{
 assert.equal(temporalConfig({}).mode,'LEGACY');
 assert.throws(()=>temporalConfig({AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',AGY_STAGE_ONLY:'true',TEMPORAL_ADDRESS:'external.example:7233'}),/LOCAL_STAGING_ONLY/);
});

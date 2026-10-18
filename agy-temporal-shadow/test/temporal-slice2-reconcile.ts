import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {TemporalBridge} from '../src/temporal/bridge.js';
const out=resolve('../../../outputs/temporal-staging-02'),b=JSON.parse(await readFile(out+'/slice2-binding.local.json','utf8')),m=JSON.parse(await readFile(out+'/MISSION.json','utf8'));
const db=new URL(process.env.AGY_TEST_DATABASE_URL!);if(db.hostname!=='127.0.0.1'||db.port!=='55438')throw new Error('LOCAL_DB_REQUIRED');
db.searchParams.set('options',`-c search_path=${b.schema},public -c role=${b.role}`);
const pool=new Pool({connectionString:db.toString()});
try{
 const p=new TemporalBridge(pool).pool(m);
 const operations=(await p.query('SELECT workflow_id,attempt,operation_id,request_id,state,ack,checkpoint,result,error,created_at,updated_at FROM agy_temporal_native_operations ORDER BY created_at')).rows;
 const missions=(await p.query("SELECT mission_id,task_key,idempotency_key,workflow_id,run_id,state,qa_state,operation_id FROM agy_temporal_missions WHERE executor_worker_id='CODEX_ENGINEERING_COMMAND' ORDER BY created_at")).rows;
 await writeFile(out+'/NATIVE-OPERATIONS-RECONCILIATION.json',JSON.stringify({observed_at:new Date().toISOString(),action:'READ_ONLY_NO_RESUBMISSION',operations,missions,old_streaming_rpc_response:'NOT_PRESERVED_BY_FIRST_ADAPTER_VERSION; do not infer accepted or rejected',old_uncertain_disposition:'RETAIN_UNCERTAIN_NO_RETRY',gateway_r1:'RPC_INVALID_REQUEST_BEFORE_COMMAND; corrected request has distinct task R2',native_chat_ingestion:'UNVERIFIED'},null,2));
 console.log(JSON.stringify(operations.map(x=>({operation_id:x.operation_id,state:x.state,ack:!!x.ack}))));
}finally{await pool.end();}

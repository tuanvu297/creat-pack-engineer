// SQL integration tests v2 for agy-gateway-rpc.candidate-v2.sql.
// Evidence class: LOCAL integration. Runs against a REAL local PostgreSQL
// 18.4 (embedded-postgres) at GW_PG_URL, with the inferred agy_shadow DDL
// and a minimal pgmq test double. Flow: install the DEPLOYED definitions,
// simulate the control-plane-verified live ACL (anon/authenticated EXECUTE
// off, service_role on), then apply candidate v2 and test Q1–Q4 behaviour.
// Not run against Supabase or the deployed gateway.
import pg from 'pg';
import {readFileSync} from 'node:fs';

const ROOT = process.env.GW_ROOT; // gateway-candidate dir
const SUPP = process.env.GW_SUPP; // gateway-supplement-20261027 dir
const results = [];
function check(name, cond, detail = '') {
  results.push({name, pass: Boolean(cond), detail});
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const client = new pg.Client({connectionString: process.env.GW_PG_URL});
await client.connect();
await client.query('drop schema if exists agy_shadow cascade');
await client.query('drop schema if exists pgmq cascade');
await client.query(`do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$`);
await client.query(readFileSync(`${ROOT}/test/sql/setup-shadow-schema.sql`, 'utf8'));
// v2 adds workers.scopes; the setup DDL predates it, so add it here exactly
// as the candidate's own idempotent ALTER would.
await client.query(`alter table agy_shadow.workers add column if not exists scopes jsonb not null default '{}'::jsonb`);
// The pg_get_functiondef export separates its statements without trailing
// semicolons; terminate each function block for the simple query protocol.
const deployedSql = readFileSync(`${SUPP}/agy-gateway-rpc.deployed-20261027.sql`, 'utf8')
  .replace(/\$function\$(\s*\n\s*\n)/g, '$function$;$1')
  .replace(/\$function\$\s*$/, '$function$;');
await client.query(deployedSql);
check('deployed RPC definitions install', true);

// Simulate the live ACL exactly as the control plane verified it read-only.
await client.query(`revoke execute on function public.agy_gateway_rpc(text, jsonb) from public, anon, authenticated;
revoke execute on function public.agy_gateway_claim_rpc(jsonb) from public, anon, authenticated;
revoke execute on function public.agy_gateway_callback_rpc(jsonb) from public, anon, authenticated;
grant execute on function public.agy_gateway_rpc(text, jsonb) to service_role;
grant execute on function public.agy_gateway_claim_rpc(jsonb) to service_role;
grant execute on function public.agy_gateway_callback_rpc(jsonb) to service_role;`);
let acl = await client.query(`select has_function_privilege('anon', 'public.agy_gateway_rpc(text,jsonb)', 'EXECUTE') as anon_x,
  has_function_privilege('service_role', 'public.agy_gateway_rpc(text,jsonb)', 'EXECUTE') as svc_x`);
check('live ACL baseline: anon cannot execute, service_role can', acl.rows[0].anon_x === false && acl.rows[0].svc_x === true);
async function asRole(role, fn) {
  await client.query('begin');
  await client.query(`set local role ${role}`);
  try { return await fn(); } finally { await client.query('rollback'); }
}
let denied = null;
await asRole('anon', async () => {
  try { await client.query(`select public.agy_gateway_rpc('health','{}'::jsonb)`); } catch (e) { denied = e.message; }
});
check('direct RPC call as anon is permission-denied', /permission denied/i.test(denied ?? ''), denied ?? '');

await client.query(readFileSync(`${ROOT}/agy-gateway-rpc.candidate-v2.sql`, 'utf8'));
check('candidate v2 SQL installs', true);
acl = await client.query(`select
  has_function_privilege('anon', 'public.agy_gateway_rpc(text,jsonb)', 'EXECUTE') as a1,
  has_function_privilege('authenticated', 'public.agy_gateway_claim_rpc(jsonb)', 'EXECUTE') as a2,
  has_function_privilege('anon', 'agy_shadow.assert_caller_(jsonb,text)', 'EXECUTE') as a3,
  has_function_privilege('authenticated', 'agy_shadow.assert_shadow_staging_()', 'EXECUTE') as a4,
  has_function_privilege('service_role', 'public.agy_gateway_callback_rpc(jsonb)', 'EXECUTE') as s1,
  has_function_privilege('service_role', 'agy_shadow.assert_caller_(jsonb,text)', 'EXECUTE') as s2`);
const r0 = acl.rows[0];
check('candidate preserves the live ACL and restricts the new helpers', !r0.a1 && !r0.a2 && !r0.a3 && !r0.a4 && r0.s1 && r0.s2, JSON.stringify(r0));
denied = null;
await asRole('anon', async () => {
  try { await client.query(`select public.agy_gateway_claim_rpc('{}'::jsonb)`); } catch (e) { denied = e.message; }
});
check('direct claim call as anon is still permission-denied after candidate', /permission denied/i.test(denied ?? ''), denied ?? '');
const healthSvc = await asRole('service_role', async () => client.query(`select public.agy_gateway_rpc('health','{}'::jsonb) as v`));
check('service_role can still execute after candidate', healthSvc.rows[0].v.status === 'PASS');

const rpc = async (fn, args) => {
  try { const r = await client.query(`select ${fn} as v`, args); return {ok: true, value: r.rows[0].v}; }
  catch (e) { return {ok: false, error: e.message}; }
};
const main = (action, payload) => rpc('public.agy_gateway_rpc($1, $2::jsonb)', [action, JSON.stringify(payload)]);
const claim = (payload) => rpc('public.agy_gateway_claim_rpc($1::jsonb)', [JSON.stringify(payload)]);
const callback = (payload) => rpc('public.agy_gateway_callback_rpc($1::jsonb)', [JSON.stringify(payload)]);
const CONTROL = {_caller: {worker_id: 'AGY-CONTROL', provider: 'R11', role: 'CONTROL'}};
const asMuse = {_caller: {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER'}};
const asGemini = {_caller: {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI', role: 'WORKER'}};
const unhide = () => client.query('update pgmq.q_agy_tasks_shadow set vt_until = now()');
// Control-plane hold: a task that must not move through this route keeps its
// row and state; only its queue message is parked by archiving the copy.
const holdTask = (taskId) => client.query("select pgmq.archive('agy_tasks_shadow', msg_id) from pgmq.q_agy_tasks_shadow where message->>'task_id'=$1", [taskId]);

// --- Q1: provisioning model ---
let r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', ...asMuse});
check('Q1 worker cannot provision itself', !r.ok && /WORKER_NOT_PROVISIONED/.test(r.error), r.error ?? '');
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', capabilities: ['text', 'planning', 'qa'],
  scopes: {missions: ['M-SEO'], projects: ['GL_AUTOMATION'], task_types: ['planning', 'research'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE']}, ...CONTROL});
check('Q1 CONTROL provisions MUSE with scopes, validated', r.ok && r.value.validated === true && r.value.provisioned === true, JSON.stringify(r.value));
r = await main('register_worker', {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI', capabilities: ['text', 'qa'],
  scopes: {missions: ['M-SEO'], task_types: ['research', 'qa'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE']}, ...CONTROL});
check('Q1 CONTROL provisions GEMINI', r.ok && r.value.validated === true);
await main('register_worker', {worker_id: 'R11-LEGACY', provider: 'R11', capabilities: ['code'], ...CONTROL});
await client.query("update agy_shadow.workers set last_validated_at = null where worker_id='R11-LEGACY'");
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', capabilities: ['text', 'planning', 'qa'], ...asMuse});
check('Q1 worker heartbeat with unchanged authorization passes', r.ok && r.value.status === 'PASS');
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', capabilities: ['text', 'planning', 'qa', 'publish'], ...asMuse});
check('Q1 worker widening its own capabilities is denied', !r.ok && /SCOPE_CHANGE_DENIED/.test(r.error), r.error ?? '');
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', scopes: {missions: ['*']}, ...asMuse});
check('Q1 worker widening its own scopes is denied', !r.ok && /SCOPE_CHANGE_DENIED/.test(r.error), r.error ?? '');
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'GEMINI', ...CONTROL});
check('Q1 provider stays immutable even for CONTROL register', !r.ok && /WORKER_PROVIDER_MISMATCH/.test(r.error), r.error ?? '');

// --- tasks (CONTROL) ---
const tb = {mission_id: 'M-SEO', objective: 'qa v2', source_version: 'cand2', mission_metadata: {project_id: 'GL_AUTOMATION', allowed_providers: ['MUSE', 'GEMINI']}, ...CONTROL};
await main('create_task', {...tb, task_id: 'T-SEO1', idempotency_key: 'K-SEO1', trace_id: 'TR-SEO1', payload: {target_provider: 'MUSE', task_type: 'planning', auto_dispatch: false}});
await main('create_task', {...tb, task_id: 'T-NOSCOPE', idempotency_key: 'K-NS', trace_id: 'TR-NS', payload: {task_type: 'planning'}});
await main('create_task', {...tb, task_id: 'T-OK', idempotency_key: 'K-OK', trace_id: 'TR-OK', payload: {target_provider: 'MUSE', task_type: 'planning', required_capabilities: ['text']}});
await main('create_task', {...tb, task_id: 'T-TYPE', idempotency_key: 'K-TY', trace_id: 'TR-TY', payload: {target_provider: 'MUSE', task_type: 'publish'}});
await main('create_task', {mission_id: 'M-OTHER', objective: 'other', task_id: 'T-MIS', idempotency_key: 'K-MIS', trace_id: 'TR-MIS', payload: {target_provider: 'MUSE', task_type: 'planning'}, ...CONTROL});

// --- Q1/Q3: claim fail-closed behaviour ---
r = await claim({worker_id: 'MUSE-SEO-1'});
check('Q3 claim without a caller identity fails closed', !r.ok && /CALLER_REQUIRED/.test(r.error), r.error ?? '');
r = await claim({worker_id: 'R11-LEGACY', _caller: {worker_id: 'R11-LEGACY', provider: 'R11', role: 'WORKER'}});
check('Q1 unvalidated worker cannot claim', r.ok && r.value.status === 'WORKER_NOT_VALIDATED', JSON.stringify(r.value));
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('Q1 auto_dispatch=false task is not claimable through this route', r.ok && r.value.status === 'NOT_CLAIMABLE' && r.value.reason === 'AUTO_DISPATCH_DISABLED', JSON.stringify(r.value));
const seoAtt = await client.query("select count(*)::int n from agy_shadow.attempts where task_id='T-SEO1'");
check('Q1 the auto_dispatch=false task gained no attempt', seoAtt.rows[0].n === 0);
await holdTask('T-SEO1');
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('Q1 task without explicit routing fails closed', r.ok && r.value.status === 'NOT_CLAIMABLE' && r.value.reason === 'TASK_SCOPE_MISSING', JSON.stringify(r.value));
await holdTask('T-NOSCOPE');
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('scoped happy path: MUSE claims T-OK', r.ok && r.value.status === 'LEASED' && r.value.task_id === 'T-OK', JSON.stringify(r.value?.status));
const lease = r.value;
const lp = {task_id: 'T-OK', attempt_id: lease.attempt_id, worker_id: 'MUSE-SEO-1', trace_id: 'TR-OK', idempotency_key: 'K-OK', lease_token: lease.lease_token, fence: lease.fence, ...asMuse};
r = await main('ack', lp);
check('ack passes with the exact lease', r.ok && r.value.status === 'ACKED');

// --- Q4: checkpoint / result replay conflicts ---
r = await main('checkpoint', {...lp, version: 1, state: {step: 'a'}, evidence: {external_operation_id: 'op-ck'}});
check('Q4 checkpoint v1 accepted', r.ok && r.value.status === 'CHECKPOINTED' && r.value.replay === false);
r = await main('checkpoint', {...lp, version: 1, state: {step: 'DIFFERENT'}, evidence: {external_operation_id: 'op-ck'}});
check('Q4 same checkpoint version with different state conflicts', !r.ok && /CHECKPOINT_CONFLICT/.test(r.error), r.error ?? '');
r = await main('checkpoint', {...lp, version: 1, state: {step: 'a'}, evidence: {external_operation_id: 'op-ck'}});
check('Q4 identical checkpoint replay is idempotent', r.ok && r.value.replay === true);
r = await main('result', {...lp, result_version: 1, output: {x: 1}, evidence: {external_operation_id: 'op-1'}});
check('Q4 result without an explicit status is refused (no default PASS)', !r.ok && /RESULT_STATUS_REQUIRED/.test(r.error), r.error ?? '');
r = await main('result', {...lp, result_version: 1, result_status: 'RESULT_READY', output: {x: 1}, evidence: {}});
check('Q4 result without evidence is refused', !r.ok && /EVIDENCE_REQUIRED/.test(r.error), r.error ?? '');
r = await main('result', {...lp, result_version: 1, result_status: 'RESULT_READY', output: {x: 1}, evidence: {external_operation_id: 'op-1'}});
check('Q4 result with status + evidence is stored and mints callback authority', r.ok && r.value.status === 'RESULT_SUBMITTED' && typeof r.value.callback_authority === 'string' && r.value.callback_authority.length === 64, JSON.stringify(r.value?.callback_authority)?.slice(0, 20));
r = await main('result', {...lp, result_version: 1, result_status: 'RESULT_READY', output: {x: 1}, evidence: {external_operation_id: 'op-1'}});
check('Q4 identical result replay against the released lease is denied by lease validation (no silent re-submit)', !r.ok && /lease invalid or expired/.test(r.error), r.error ?? '');
r = await main('create_task', {...tb, task_id: 'T-OK', idempotency_key: 'K-OK', trace_id: 'TR-OK', payload: {target_provider: 'MUSE', task_type: 'planning', required_capabilities: ['text']}});
check('Q4 identical create replay is IDEMPOTENT_REPLAY', r.ok && r.value.status === 'IDEMPOTENT_REPLAY');
r = await main('create_task', {...tb, task_id: 'T-OK', idempotency_key: 'K-OK', trace_id: 'TR-OK', payload: {target_provider: 'MUSE', task_type: 'planning', required_capabilities: ['text'], changed: true}});
check('Q4 same task id with different payload conflicts', !r.ok && /TASK_CONTENT_CONFLICT/.test(r.error), r.error ?? '');

// --- Q2: callback authority = fenced result receipt ---
const cb = {task_id: 'T-OK', attempt_id: lease.attempt_id, trace_id: 'TR-OK', idempotency_key: 'K-OK', callback_id: 'CB-OK', worker_id: 'MUSE-SEO-1', lease_token: lease.lease_token, fence: lease.fence, callback_payload: {note: 'ready'}, evidence: {external_operation_id: 'op-1'}, ...asMuse};
r = await callback({task_id: 'T-OK', attempt_id: lease.attempt_id, trace_id: 'TR-OK', idempotency_key: 'K-OK', callback_id: 'CB-X', worker_id: 'MUSE-SEO-1', lease_token: lease.lease_token, fence: lease.fence});
check('Q3 callback without a caller identity fails closed', !r.ok && /CALLER_REQUIRED/.test(r.error), r.error ?? '');
r = await callback({...cb, lease_token: '00000000-0000-0000-0000-000000000000'});
check('Q2 callback with a wrong lease token is denied', !r.ok && /CALLBACK_AUTHORITY_DENIED/.test(r.error), r.error ?? '');
r = await callback({...cb, fence: lease.fence + 9});
check('Q2 callback with a wrong fence is denied', !r.ok && /CALLBACK_AUTHORITY_DENIED/.test(r.error), r.error ?? '');
r = await callback({...cb, attempt_id: 'ATT-doesnotexist'});
check('Q2 callback with a foreign attempt is denied', !r.ok && /attempt not found/.test(r.error), r.error ?? '');
r = await callback(cb);
check('Q2 callback with the exact result receipt is recorded PENDING', r.ok && r.value.status === 'PENDING' && r.value.target === 'CHATGPT_ASSISTANT_CONTROL_PLANE', JSON.stringify(r.value?.status));
r = await callback(cb);
check('Q2 correct callback replay is idempotent', r.ok && r.value.callback_id === 'CB-OK');
r = await callback({...cb, evidence: {external_operation_id: 'op-CHANGED'}});
check('Q2 same callback id with changed evidence conflicts', !r.ok && /CALLBACK_CONFLICT/.test(r.error), r.error ?? '');

// --- Q4: readback contract ---
r = await main('readback', {task_id: 'T-OK', worker_id: 'GEMINI-SEO-1', ...asGemini});
check('Q4 readback by a non-participant worker is denied', !r.ok && /READBACK_DENIED/.test(r.error), r.error ?? '');
r = await main('readback', {task_id: 'T-OK', worker_id: 'MUSE-SEO-1', ...asMuse});
check('Q4 readback returns stored status/result/callback with semantics', r.ok && r.value.task.status === 'RESULT_SUBMITTED' && r.value.callback.status === 'PENDING' && /recorded only/.test(r.value.callback_semantics), JSON.stringify(r.value?.callback));
r = await main('readback', {task_id: 'T-OK', ...CONTROL});
check('Q4 CONTROL readback passes', r.ok && r.value.task.task_id === 'T-OK');

// --- Q1: remaining scope checks on the queue tail ---
await unhide();
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('Q1 task_type outside the provisioned worker scope is NOT_ELIGIBLE', r.ok && r.value.status === 'NOT_ELIGIBLE' && r.value.reason === 'WORKER_TASK_TYPE_SCOPE', JSON.stringify(r.value));
await holdTask('T-TYPE');
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('Q1 mission outside the provisioned worker scope is NOT_ELIGIBLE', r.ok && r.value.status === 'NOT_ELIGIBLE' && r.value.reason === 'WORKER_MISSION_SCOPE', JSON.stringify(r.value));

await client.end();
const failed = results.filter((x) => !x.pass);
console.log(`\nSQL V2 TESTS: ${results.length - failed.length}/${results.length} pass`);
process.exit(failed.length ? 1 : 0);

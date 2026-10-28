// SQL integration tests for agy-gateway-rpc.candidate.sql against a REAL
// local PostgreSQL (embedded-postgres, PG 18) with the inferred agy_shadow
// DDL and a minimal pgmq test double. Evidence class: LOCAL integration.
// Not run against Supabase, not run against the deployed gateway.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {readFileSync} from 'node:fs';

const ROOT = process.env.GW_ROOT; // gateway-candidate dir inside the /tmp test copy
const results = [];
function check(name, cond, detail = '') {
  results.push({name, pass: Boolean(cond), detail});
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const instance = new EmbeddedPostgres({databaseDir: '/tmp/agy-gw-pgdata', user: 'postgres', password: 'test', persistent: false, port: 55441});
await instance.initialise();
await instance.start();
await instance.createDatabase('agytest');
const client = new pg.Client({host: '127.0.0.1', port: 55441, user: 'postgres', password: 'test', database: 'agytest'});
await client.connect();
await client.query("select sha256('preflight'::bytea)"); // candidate SQL relies on core sha256()
await client.query(readFileSync(`${ROOT}/test/sql/setup-shadow-schema.sql`, 'utf8'));
await client.query(readFileSync(`${ROOT}/agy-gateway-rpc.candidate.sql`, 'utf8'));
check('candidate SQL installs on real PostgreSQL', true);

const rpc = async (fn, args) => {
  try {
    const r = await client.query(`select ${fn} as v`, args);
    return {ok: true, value: r.rows[0].v};
  } catch (e) { return {ok: false, error: e.message}; }
};
const main = (action, payload) => rpc('public.agy_gateway_rpc($1, $2::jsonb)', [action, JSON.stringify(payload)]);
const claim = (payload) => rpc('public.agy_gateway_claim_rpc($1::jsonb)', [JSON.stringify(payload)]);
const callback = (payload) => rpc('public.agy_gateway_callback_rpc($1::jsonb)', [JSON.stringify(payload)]);
const CONTROL = {_caller: {worker_id: 'AGY-CONTROL', provider: 'R11', role: 'CONTROL'}};
const asMuse = {_caller: {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER'}};
const asGemini = {_caller: {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI', role: 'WORKER'}};
const unhideQueue = () => client.query('update pgmq.q_agy_tasks_shadow set vt_until = now()');

// --- registration & identity ---
let r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', capabilities: ['text', 'planning', 'qa'], ...asMuse});
check('register MUSE by its own caller', r.ok && r.value.status === 'PASS');
r = await main('register_worker', {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI', capabilities: ['text', 'qa'], ...asGemini});
check('register GEMINI by its own caller', r.ok && r.value.status === 'PASS');
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'GEMINI', ...CONTROL});
check('relabel attack: existing MUSE worker cannot be re-registered as GEMINI', !r.ok && /WORKER_PROVIDER_MISMATCH/.test(r.error), r.error ?? '');
r = await main('register_worker', {worker_id: 'MUSE-SEO-1', provider: 'MUSE', ...asGemini});
check('register with a foreign caller identity is rejected', !r.ok && /CALLER_IDENTITY_MISMATCH/.test(r.error), r.error ?? '');
r = await main('register_worker', {worker_id: 'NOBODY-1', provider: 'MUSE'});
check('mutating action without a caller identity is rejected', !r.ok && /CALLER_REQUIRED/.test(r.error), r.error ?? '');
const w = await client.query("select last_validated_at from agy_shadow.workers where worker_id='MUSE-SEO-1'");
check('self-registration does not self-validate (last_validated_at stays null)', w.rows[0].last_validated_at === null);

// --- task creation is control-only ---
const taskBase = {mission_id: 'M-SEO', objective: 'qualification', source_version: 'cand'};
r = await main('create_task', {...taskBase, task_id: 'T-BAD', idempotency_key: 'K-BAD', trace_id: 'TR-BAD', ...asMuse});
check('create_task by a WORKER caller is refused', !r.ok && /FORBIDDEN_ROLE/.test(r.error), r.error ?? '');
r = await main('create_task', {...taskBase, task_id: 'T-GEM', idempotency_key: 'K-GEM', trace_id: 'TR-GEM', payload: {target_provider: 'GEMINI', name: 'gemini task'}, ...CONTROL});
check('create_task T-GEM by CONTROL', r.ok && r.value.status === 'CREATED');
await main('create_task', {...taskBase, task_id: 'T-CAP', idempotency_key: 'K-CAP', trace_id: 'TR-CAP', payload: {required_capabilities: ['publish'], name: 'publish task'}, ...CONTROL});
await main('create_task', {...taskBase, task_id: 'T-OPEN', idempotency_key: 'K-OPEN', trace_id: 'TR-OPEN', payload: {name: 'open task'}, ...CONTROL});
await main('create_task', {mission_id: 'M-GEM-ONLY', objective: 'scoped', task_id: 'T-M2', idempotency_key: 'K-M2', trace_id: 'TR-M2', mission_metadata: {allowed_providers: ['GEMINI']}, payload: {name: 'mission scoped'}, ...CONTROL});

// --- claim scoping ---
r = await claim({worker_id: 'GHOST-1', provider: 'MUSE', _caller: {worker_id: 'GHOST-1', provider: 'MUSE', role: 'WORKER'}});
check('unregistered worker cannot claim (no auto-provisioning)', r.ok && r.value.status === 'WORKER_NOT_REGISTERED');
r = await claim({worker_id: 'MUSE-SEO-1', provider: 'GEMINI', ...asMuse});
check('claim with a provider that disagrees with the registration is rejected', !r.ok && /WORKER_PROVIDER_MISMATCH/.test(r.error), r.error ?? '');
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('MUSE claim hits the GEMINI-targeted head task and is NOT_ELIGIBLE', r.ok && r.value.status === 'NOT_ELIGIBLE' && r.value.reason === 'TARGET_PROVIDER', JSON.stringify(r.value));
const att = await client.query("select count(*)::int n from agy_shadow.attempts where task_id='T-GEM'");
check('no attempt/lease was created by the ineligible claim', att.rows[0].n === 0);
await unhideQueue();
r = await claim({worker_id: 'GEMINI-SEO-1', ...asGemini});
check('GEMINI claims its targeted task', r.ok && r.value.status === 'LEASED' && r.value.task_id === 'T-GEM', JSON.stringify(r.value?.status));
const lease = r.value;
await unhideQueue();
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('re-reading a leased task message cannot double-lease (NOT_CLAIMABLE/LEASED)', r.ok && r.value.status === 'NOT_CLAIMABLE' && r.value.task_status === 'LEASED', JSON.stringify(r.value));
const attAfter = await client.query("select count(*)::int n from agy_shadow.attempts where task_id='T-GEM'");
check('still exactly one attempt exists for the leased task', attAfter.rows[0].n === 1);

// --- lease actions keep the deployed validation ---
const leasePayload = {task_id: lease.task_id, attempt_id: lease.attempt_id, worker_id: 'GEMINI-SEO-1', trace_id: lease.trace_id, idempotency_key: lease.idempotency_key, lease_token: lease.lease_token, ...asGemini};
r = await main('ack', {...leasePayload, fence: 999});
check('ack with a wrong fence is rejected', !r.ok && /token\/fence mismatch/.test(r.error), r.error ?? '');
r = await main('ack', {...leasePayload, fence: lease.fence});
check('ack with the exact lease identity passes', r.ok && r.value.status === 'ACKED');
r = await main('result', {...leasePayload, fence: lease.fence, result_version: 1, result_status: 'RESULT_READY', output: {note: 'done'}, evidence: {external_operation_id: 'op-1'}});
check('result submission passes and releases the lease', r.ok && r.value.status === 'RESULT_SUBMITTED');

// --- callback: immutable, server-derived ---
const cbBase = {task_id: 'T-GEM', attempt_id: lease.attempt_id, trace_id: 'TR-GEM', idempotency_key: 'K-GEM', callback_id: 'CB-1', worker_id: 'GEMINI-SEO-1', callback_payload: {note: 'ready'}, evidence: {external_operation_id: 'op-1'}, ...asGemini};
r = await callback({...cbBase, worker_id: 'MUSE-SEO-1', _caller: asMuse._caller});
check('callback by a worker that is not the assigned worker is rejected', !r.ok && /callback worker mismatch/.test(r.error), r.error ?? '');
r = await callback({...cbBase, target: 'ATTACKER', callback_status: 'DELIVERED'});
check('callback stores PENDING with the derived default target', r.ok && r.value.status === 'PENDING' && r.value.target === 'CHATGPT_ASSISTANT_CONTROL_PLANE', JSON.stringify(r.value));
const cbRow = await client.query("select status, target, delivered_at from agy_shadow.callbacks where callback_id='CB-1'");
check('delivered_at is never set by the worker path', cbRow.rows.length === 1 && cbRow.rows[0].delivered_at === null && cbRow.rows[0].status === 'PENDING');
r = await callback(cbBase);
check('identical callback replay returns the stored row', r.ok && r.value.callback_id === 'CB-1' && r.value.status === 'PENDING');
r = await callback({...cbBase, evidence: {external_operation_id: 'op-DIFFERENT'}});
check('same callback_id with different content raises CALLBACK_CONFLICT', !r.ok && /CALLBACK_CONFLICT/.test(r.error), r.error ?? '');

// --- capability + mission scope ---
await unhideQueue();
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('task requiring an unregistered capability is NOT_ELIGIBLE for MUSE', r.ok && r.value.status === 'NOT_ELIGIBLE' && r.value.reason === 'CAPABILITY', JSON.stringify(r.value));
await client.query("select pgmq.archive('agy_tasks_shadow', msg_id) from pgmq.q_agy_tasks_shadow where message->>'task_id'='T-CAP'"); // control-plane removal of only the blocking head (head-of-line behaviour, see runbook)
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('MUSE claims the open task', r.ok && r.value.status === 'LEASED' && r.value.task_id === 'T-OPEN', JSON.stringify(r.value?.task_id));
const openLease = r.value;
// Finish T-OPEN so its queue message is archived at result; otherwise the
// leased head message keeps resurfacing for every later claim (deployed
// design: messages are archived on result, not on claim).
const openPayload = {task_id: openLease.task_id, attempt_id: openLease.attempt_id, worker_id: 'MUSE-SEO-1', trace_id: openLease.trace_id, idempotency_key: openLease.idempotency_key, lease_token: openLease.lease_token, fence: openLease.fence, ...asMuse};
await main('ack', openPayload);
r = await main('result', {...openPayload, result_version: 1, result_status: 'RESULT_READY', output: {}, evidence: {}});
check('open task result archives its queue message', r.ok && r.value.status === 'RESULT_SUBMITTED' && r.value.queue_archived === true);
await unhideQueue();
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('mission allowlist excludes MUSE from the GEMINI-only mission', r.ok && r.value.status === 'NOT_ELIGIBLE' && r.value.reason === 'MISSION_SCOPE', JSON.stringify(r.value));
await unhideQueue();
r = await claim({worker_id: 'GEMINI-SEO-1', ...asGemini});
check('GEMINI claims the mission-scoped task', r.ok && r.value.status === 'LEASED' && r.value.task_id === 'T-M2', JSON.stringify(r.value?.task_id));

// --- single claim/callback paths + staging guard ---
r = await main('claim', {worker_id: 'MUSE-SEO-1', ...asMuse});
check('duplicate claim branch inside agy_gateway_rpc is removed', !r.ok && /claim must use agy_gateway_claim_rpc/.test(r.error), r.error ?? '');
r = await main('callback', {task_id: 'T-GEM', attempt_id: lease.attempt_id, worker_id: 'GEMINI-SEO-1', trace_id: 'TR-GEM', idempotency_key: 'K-GEM', callback_id: 'CB-2', lease_token: lease.lease_token, fence: lease.fence, ...asGemini});
check('duplicate callback branch inside agy_gateway_rpc is removed', !r.ok && /callback must use agy_gateway_callback_rpc/.test(r.error), r.error ?? '');
await client.query("update agy_shadow.schema_meta set value = value || '{\"mode\":\"PRODUCTION\"}'::jsonb where key='state_plane'");
r = await claim({worker_id: 'MUSE-SEO-1', ...asMuse});
check('staging guard refuses claims when the state plane is not SHADOW_STAGING', !r.ok && /not SHADOW_STAGING/.test(r.error), r.error ?? '');
await client.query("update agy_shadow.schema_meta set value = value || '{\"mode\":\"SHADOW_STAGING\"}'::jsonb where key='state_plane'");
r = await main('health', {});
check('health still reports the shadow mode and D049 authority', r.ok && r.value.canonical_authority === 'EXISTING_POSTGRES_D049' && r.value.mode === 'SHADOW_STAGING');

await client.end();
await instance.stop();
const failed = results.filter((x) => !x.pass);
console.log(`\nSQL TESTS: ${results.length - failed.length}/${results.length} pass`);
process.exit(failed.length ? 1 : 0);

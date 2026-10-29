-- AGY gateway RPCs — CANDIDATE v2 (phase: AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1)
-- Supersedes agy-gateway-rpc.candidate.sql (v1) after Control Plane QA.
-- Derived from the deployed definitions collected 2026-10-27 via
-- pg_get_functiondef. NOT DEPLOYED anywhere.
--
-- Canonical authority remains EXISTING_POSTGRES_D049. These functions run on
-- the Supabase SHADOW state plane only (staging guard below). The canonical
-- port of the same contract lives in the canonical/ package of this
-- qualification and reuses the repo's existing PostgresStore leases and
-- platform identities — it is not this file.
--
-- v2 changes (Control Plane QA Q1–Q4):
--  Q1 Authorization scopes are provisioned by CONTROL and are immutable to
--     the worker. register_worker no longer lets a WORKER create a worker
--     row or change capabilities/permissions/competency/scopes: a worker
--     caller may only heartbeat its own health; attempted scope changes
--     raise SCOPE_CHANGE_DENIED. Workers carry a CONTROL-provisioned
--     `scopes` jsonb (missions[], projects[], task_types[], reply_targets[]).
--     Claim additionally requires: the worker was CONTROL-validated
--     (last_validated_at set), the task carries explicit routing
--     (payload.target_provider — missing scope fails closed with
--     TASK_SCOPE_MISSING), payload.auto_dispatch is not false (the two
--     ROUTED SEO tasks carry auto_dispatch=false and stay unclaimable
--     through this route), and the worker's provisioned scopes cover the
--     task's mission/project/task_type/reply target.
--  Q2 Callback authority is a fenced result receipt. The result action
--     mints attempts.evidence.callback_authority =
--     sha256(task|attempt|lease_token|fence|result_version) at submission.
--     The callback must present the exact lease_token + fence of the
--     completed attempt; the SQL validates the attempts row worker, the
--     (released) lease row, and the minted digest. Stale, rotated or wrong
--     token/fence/attempt raises CALLBACK_AUTHORITY_DENIED. Target, status
--     and reply tool stay server-derived and immutable (v1 behaviour).
--  Q3 Fail-closed caller checks everywhere: claim and callback now raise
--     CALLER_REQUIRED when the gateway-injected _caller is absent (v1 only
--     enforced this inside agy_gateway_rpc). The ACL block at the end of
--     this file preserves the verified live grants (anon/authenticated
--     EXECUTE=false, service_role=true) for the three RPCs and applies the
--     same restriction to the new helper functions, which would otherwise
--     receive Postgres' default PUBLIC execute grant.
--  Q4 Replay is content-checked: create_task, checkpoint and result raise
--     TASK_CONTENT_CONFLICT / CHECKPOINT_CONFLICT / RESULT_CONFLICT when
--     the same key/id/version arrives with different payload/state/output/
--     evidence. Result requires an explicit result_status (no default
--     PASS) and evidence.external_operation_id. A new readback action
--     returns the stored task/result/callback rows; a recorded PENDING
--     callback is explicitly "recorded, not delivered/accepted".

-- Additive, idempotent: authorized scopes live on the worker row.
alter table agy_shadow.workers add column if not exists scopes jsonb not null default '{}'::jsonb;

create or replace function agy_shadow.assert_shadow_staging_()
returns void
language plpgsql
as $fn$
declare
  v_mode text := (select value->>'mode' from agy_shadow.schema_meta where key='state_plane');
begin
  if coalesce(v_mode,'') <> 'SHADOW_STAGING' then
    raise exception 'gateway state plane is not SHADOW_STAGING (mode=%); canonical authority is EXISTING_POSTGRES_D049', coalesce(v_mode,'UNSET')
      using errcode='55000';
  end if;
end;
$fn$;

create or replace function agy_shadow.assert_caller_(p_payload jsonb, p_worker_id text)
returns void
language plpgsql
as $fn$
begin
  -- Fail closed: a mutating call without a gateway-injected caller identity
  -- is never acceptable, in any of the three RPCs.
  if not (p_payload ? '_caller') then
    raise exception 'CALLER_REQUIRED' using errcode='22023';
  end if;
  -- A CONTROL caller acts on behalf of the plane (provisioning,
  -- reconciliation); its own identity is what gets recorded. A WORKER
  -- caller may only ever act as itself.
  if coalesce(p_payload->'_caller'->>'role','') = 'CONTROL' then
    return;
  end if;
  if p_worker_id is not null and coalesce(p_payload->'_caller'->>'worker_id','') <> p_worker_id then
    raise exception 'CALLER_IDENTITY_MISMATCH' using errcode='22023';
  end if;
end;
$fn$;

CREATE OR REPLACE FUNCTION public.agy_gateway_callback_rpc(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_now timestamptz := now();
  v_task agy_shadow.tasks%rowtype;
  v_attempt agy_shadow.attempts%rowtype;
  v_lease agy_shadow.leases%rowtype;
  v_existing agy_shadow.callbacks%rowtype;
  v_task_id text := nullif(p_payload->>'task_id','');
  v_attempt_id text := nullif(p_payload->>'attempt_id','');
  v_trace_id text := nullif(p_payload->>'trace_id','');
  v_idempotency_key text := nullif(p_payload->>'idempotency_key','');
  v_callback_id text := nullif(p_payload->>'callback_id','');
  v_worker_id text := nullif(p_payload->>'worker_id','');
  v_lease_token text := nullif(p_payload->>'lease_token','');
  v_fence bigint := nullif(p_payload->>'fence','')::bigint;
  v_result_version integer;
  v_authority text;
  v_target text;
  v_payload jsonb;
  v_digest text;
begin
  perform agy_shadow.assert_shadow_staging_();
  if v_task_id is null or v_attempt_id is null or v_trace_id is null or v_idempotency_key is null
     or v_callback_id is null or v_worker_id is null or v_lease_token is null or v_fence is null then
    raise exception 'task_id, attempt_id, trace_id, idempotency_key, callback_id, worker_id, lease_token, fence required' using errcode='22023';
  end if;
  perform agy_shadow.assert_caller_(p_payload, v_worker_id);
  select * into v_task from agy_shadow.tasks where task_id=v_task_id;
  if not found then raise exception 'task not found' using errcode='P0002'; end if;
  if v_task.trace_id<>v_trace_id or v_task.idempotency_key<>v_idempotency_key then raise exception 'task identity mismatch' using errcode='22023'; end if;
  if v_task.assigned_worker is distinct from v_worker_id then raise exception 'callback worker mismatch' using errcode='55000'; end if;

  -- Fenced result receipt: the callback is authorized by the completed
  -- attempt's exact lease lineage, not by having once seen the task.
  select * into v_attempt from agy_shadow.attempts where attempt_id=v_attempt_id and task_id=v_task_id;
  if not found then raise exception 'attempt not found' using errcode='P0002'; end if;
  if v_attempt.worker_id is distinct from v_worker_id then raise exception 'CALLBACK_AUTHORITY_DENIED' using errcode='55000'; end if;
  select result_version into v_result_version from agy_shadow.results
    where task_id=v_task_id and attempt_id=v_attempt_id order by result_version desc limit 1;
  if v_result_version is null then raise exception 'result required before callback' using errcode='55000'; end if;
  select * into v_lease from agy_shadow.leases where task_id=v_task_id;
  if not found or v_lease.attempt_id<>v_attempt_id or v_lease.worker_id<>v_worker_id
     or v_lease.lease_token::text<>v_lease_token or v_lease.fence<>v_fence
     or v_lease.released_at is null then
    raise exception 'CALLBACK_AUTHORITY_DENIED' using errcode='55000';
  end if;
  v_authority := encode(sha256(convert_to(concat_ws('|', v_task_id, v_attempt_id, v_lease_token, v_fence::text, v_result_version::text), 'UTF8')), 'hex');
  if v_attempt.evidence->>'callback_authority' is distinct from v_authority then
    raise exception 'CALLBACK_AUTHORITY_DENIED' using errcode='55000';
  end if;

  -- Immutable reply: target and status are server-derived. The payload may
  -- carry evidence and a callback payload, never a target or a status.
  v_target := coalesce(nullif(v_task.payload->>'callback_target',''),'CHATGPT_ASSISTANT_CONTROL_PLANE');
  v_digest := encode(sha256(convert_to(concat_ws('|', v_task_id, v_attempt_id, v_target,
    coalesce(p_payload->'callback_payload','{}'::jsonb)::text,
    coalesce(p_payload->'evidence','{}'::jsonb)::text), 'UTF8')), 'hex');
  v_payload := coalesce(p_payload->'callback_payload','{}'::jsonb) || jsonb_build_object('immutable_digest', v_digest);

  insert into agy_shadow.callbacks(callback_id,task_id,attempt_id,target,status,payload,evidence,delivered_at)
  values(v_callback_id,v_task_id,v_attempt_id,v_target,'PENDING',v_payload,coalesce(p_payload->'evidence','{}'::jsonb),null)
  on conflict(callback_id) do nothing;

  select * into v_existing from agy_shadow.callbacks where callback_id=v_callback_id;
  if v_existing.payload->>'immutable_digest' is distinct from v_digest then
    raise exception 'CALLBACK_CONFLICT' using errcode='23505';
  end if;
  return jsonb_build_object('status',v_existing.status,'callback_id',v_callback_id,'task_id',v_task_id,'attempt_id',v_attempt_id,'target',v_existing.target,
    'semantics','RECORDED_ONLY: PENDING means the reply is stored; DELIVERED is set by the control plane after actual delivery');
end;
$function$;


CREATE OR REPLACE FUNCTION public.agy_gateway_claim_rpc(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_now timestamptz := now();
  v_task agy_shadow.tasks%rowtype;
  v_worker agy_shadow.workers%rowtype;
  v_lease agy_shadow.leases%rowtype;
  v_msg pgmq.message_record;
  v_task_id text;
  v_attempt_id text;
  v_worker_id text := nullif(p_payload->>'worker_id','');
  v_provider text;
  v_lease_seconds integer := greatest(30,least(coalesce((p_payload->>'lease_seconds')::integer,120),900));
  v_attempt_no integer;
  v_queue_msg_id bigint;
  v_lease_token uuid;
  v_fence bigint;
  v_lease_exists boolean := false;
  v_target_provider text;
  v_required jsonb;
  v_allowed jsonb;
  v_scopes jsonb;
  v_project_id text;
  v_reply_target text;
begin
  perform agy_shadow.assert_shadow_staging_();
  if v_worker_id is null then raise exception 'worker_id required' using errcode='22023'; end if;
  perform agy_shadow.assert_caller_(p_payload, v_worker_id);

  -- No auto-provisioning, and no claim before CONTROL validation: identity
  -- and its authorized scopes exist only because the control plane
  -- provisioned them.
  select * into v_worker from agy_shadow.workers where worker_id=v_worker_id;
  if not found then
    return jsonb_build_object('status','WORKER_NOT_REGISTERED','worker_id',v_worker_id);
  end if;
  if v_worker.last_validated_at is null then
    return jsonb_build_object('status','WORKER_NOT_VALIDATED','worker_id',v_worker_id);
  end if;
  v_provider := v_worker.provider;
  v_scopes := coalesce(v_worker.scopes,'{}'::jsonb);
  if nullif(p_payload->>'provider','') is not null and (p_payload->>'provider') <> v_provider then
    raise exception 'WORKER_PROVIDER_MISMATCH' using errcode='22023';
  end if;

  select * into v_msg from pgmq.read('agy_tasks_shadow',30,1) limit 1;
  if v_msg.msg_id is null then return jsonb_build_object('status','EMPTY'); end if;
  v_queue_msg_id := v_msg.msg_id;
  v_task_id := v_msg.message->>'task_id';

  select * into v_task from agy_shadow.tasks where task_id=v_task_id for update;
  if not found then
    perform pgmq.archive('agy_tasks_shadow',v_queue_msg_id);
    return jsonb_build_object('status','ORPHAN_ARCHIVED','queue_msg_id',v_queue_msg_id);
  end if;

  if v_task.status not in ('CREATED','PACKAGED','ROUTED','FAILED_RETRYABLE') or v_task.available_at > v_now then
    if v_task.status in ('RESULT_SUBMITTED','QA1_PASS','QA2_PASS','MERGED','COMPLETE','FAILED_TERMINAL','UNCERTAIN_ACTION') then
      perform pgmq.archive('agy_tasks_shadow',v_queue_msg_id);
    end if;
    return jsonb_build_object('status','NOT_CLAIMABLE','task_id',v_task_id,'task_status',v_task.status);
  end if;

  -- Fail-closed task scope: a task is claimable through this route only
  -- when routing was assigned explicitly and auto-dispatch is allowed.
  if coalesce((v_task.payload->>'auto_dispatch')::boolean, true) is false then
    return jsonb_build_object('status','NOT_CLAIMABLE','reason','AUTO_DISPATCH_DISABLED','task_id',v_task_id);
  end if;
  v_target_provider := nullif(v_task.payload->>'target_provider','');
  if v_target_provider is null then
    return jsonb_build_object('status','NOT_CLAIMABLE','reason','TASK_SCOPE_MISSING','task_id',v_task_id);
  end if;
  if v_target_provider <> v_provider then
    return jsonb_build_object('status','NOT_ELIGIBLE','reason','TARGET_PROVIDER','task_id',v_task_id,'target_provider',v_target_provider);
  end if;
  v_required := v_task.payload->'required_capabilities';
  if v_required is not null and jsonb_typeof(v_required)='array'
     and not (coalesce(v_worker.capabilities,'[]'::jsonb) @> v_required) then
    return jsonb_build_object('status','NOT_ELIGIBLE','reason','CAPABILITY','task_id',v_task_id,'required_capabilities',v_required);
  end if;
  select metadata->'allowed_providers' into v_allowed from agy_shadow.missions where mission_id=v_task.mission_id;
  if v_allowed is not null and jsonb_typeof(v_allowed)='array'
     and not (v_allowed @> to_jsonb(v_provider)) then
    return jsonb_build_object('status','NOT_ELIGIBLE','reason','MISSION_SCOPE','task_id',v_task_id,'mission_id',v_task.mission_id);
  end if;

  -- CONTROL-provisioned worker scopes (immutable to the worker, see
  -- register_worker). An absent scope key means "not restricted by that
  -- key"; a present key fails closed, including on missing task fields.
  if v_scopes ? 'missions' and not (coalesce(v_scopes->'missions','[]'::jsonb) @> to_jsonb(v_task.mission_id)) then
    return jsonb_build_object('status','NOT_ELIGIBLE','reason','WORKER_MISSION_SCOPE','task_id',v_task_id,'mission_id',v_task.mission_id);
  end if;
  if v_scopes ? 'projects' then
    select metadata->>'project_id' into v_project_id from agy_shadow.missions where mission_id=v_task.mission_id;
    if v_project_id is null or not (coalesce(v_scopes->'projects','[]'::jsonb) @> to_jsonb(v_project_id)) then
      return jsonb_build_object('status','NOT_ELIGIBLE','reason','WORKER_PROJECT_SCOPE','task_id',v_task_id,'mission_id',v_task.mission_id);
    end if;
  end if;
  if v_scopes ? 'task_types' and (nullif(v_task.payload->>'task_type','') is null
     or not (coalesce(v_scopes->'task_types','[]'::jsonb) @> to_jsonb(v_task.payload->>'task_type'))) then
    return jsonb_build_object('status','NOT_ELIGIBLE','reason','WORKER_TASK_TYPE_SCOPE','task_id',v_task_id);
  end if;
  if v_scopes ? 'reply_targets' then
    v_reply_target := coalesce(nullif(v_task.payload->>'callback_target',''),'CHATGPT_ASSISTANT_CONTROL_PLANE');
    if not (coalesce(v_scopes->'reply_targets','[]'::jsonb) @> to_jsonb(v_reply_target)) then
      return jsonb_build_object('status','NOT_ELIGIBLE','reason','WORKER_REPLY_SCOPE','task_id',v_task_id,'reply_target',v_reply_target);
    end if;
  end if;

  select * into v_lease from agy_shadow.leases where task_id=v_task_id for update;
  v_lease_exists := found;
  if v_lease_exists and v_lease.released_at is null and v_lease.expires_at > v_now then
    return jsonb_build_object('status','ALREADY_LEASED','task_id',v_task_id,'expires_at',v_lease.expires_at,'fence',v_lease.fence);
  end if;

  v_attempt_no := coalesce((select max(attempt_no)+1 from agy_shadow.attempts where task_id=v_task_id),1);
  v_attempt_id := 'ATT-' || replace(gen_random_uuid()::text,'-','');
  insert into agy_shadow.attempts(attempt_id,task_id,attempt_no,worker_id,status,evidence,started_at)
  values(v_attempt_id,v_task_id,v_attempt_no,v_worker_id,'LEASED',jsonb_build_object('queue_msg_id',v_queue_msg_id),v_now);

  if v_lease_exists then
    update agy_shadow.leases
      set attempt_id=v_attempt_id,worker_id=v_worker_id,lease_token=gen_random_uuid(),fence=fence+1,acquired_at=v_now,expires_at=v_now+make_interval(secs=>v_lease_seconds),released_at=null
      where task_id=v_task_id
      returning lease_token,fence into v_lease_token,v_fence;
  else
    insert into agy_shadow.leases(task_id,attempt_id,worker_id,expires_at)
      values(v_task_id,v_attempt_id,v_worker_id,v_now+make_interval(secs=>v_lease_seconds))
      returning lease_token,fence into v_lease_token,v_fence;
  end if;

  update agy_shadow.tasks set status='LEASED',assigned_worker=v_worker_id,updated_at=v_now where task_id=v_task_id;
  update agy_shadow.workers set health='ONLINE',last_seen_at=v_now,updated_at=v_now where worker_id=v_worker_id;
  insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
  values(v_task.mission_id,v_task_id,v_attempt_id,'TASK_CLAIMED',v_worker_id,v_task.status,'LEASED',v_task.trace_id,jsonb_build_object('lease_fence',v_fence,'queue_msg_id',v_queue_msg_id,'provider',v_provider));

  return jsonb_build_object('status','LEASED','task_id',v_task_id,'mission_id',v_task.mission_id,'attempt_id',v_attempt_id,'attempt_no',v_attempt_no,'worker_id',v_worker_id,'provider',v_provider,'lease_token',v_lease_token,'fence',v_fence,'expires_at',v_now+make_interval(secs=>v_lease_seconds),'idempotency_key',v_task.idempotency_key,'trace_id',v_task.trace_id,'payload',v_task.payload,'acceptance_criteria',v_task.acceptance_criteria,'queue_msg_id',v_queue_msg_id);
end;
$function$;


CREATE OR REPLACE FUNCTION public.agy_gateway_rpc(p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_now timestamptz := now();
  v_task agy_shadow.tasks%rowtype;
  v_worker agy_shadow.workers%rowtype;
  v_lease agy_shadow.leases%rowtype;
  v_checkpoint agy_shadow.checkpoints%rowtype;
  v_result agy_shadow.results%rowtype;
  v_callback agy_shadow.callbacks%rowtype;
  v_task_id text;
  v_mission_id text;
  v_attempt_id text;
  v_worker_id text;
  v_trace_id text;
  v_idempotency_key text;
  v_lease_seconds integer;
  v_version integer;
  v_result_version integer;
  v_queue_msg_id bigint;
  v_inserted boolean := false;
  v_status text;
  v_objective text;
  v_provider text;
  v_role text;
  v_is_control boolean := false;
begin
  if p_payload is null then p_payload := '{}'::jsonb; end if;

  if p_action = 'health' then
    return jsonb_build_object(
      'status','PASS',
      'mode','SHADOW_STAGING',
      'canonical_authority','EXISTING_POSTGRES_D049',
      'schema_version',coalesce((select value->>'schema_version' from agy_shadow.schema_meta where key='state_plane'),'UNKNOWN'),
      'db_time',v_now
    );
  end if;

  perform agy_shadow.assert_shadow_staging_();
  if not (p_payload ? '_caller') then
    raise exception 'CALLER_REQUIRED' using errcode='22023';
  end if;
  v_is_control := coalesce(p_payload->'_caller'->>'role','') = 'CONTROL';

  if p_action = 'register_worker' then
    v_worker_id := nullif(p_payload->>'worker_id','');
    v_provider := nullif(p_payload->>'provider','');
    v_role := coalesce(nullif(p_payload->>'role',''),'WORKER');
    if v_worker_id is null then raise exception 'worker_id required' using errcode='22023'; end if;
    perform agy_shadow.assert_caller_(p_payload, v_worker_id);
    select * into v_worker from agy_shadow.workers where worker_id=v_worker_id;

    if not found then
      -- Provisioning is a CONTROL act. A worker can never mint itself.
      if not v_is_control then raise exception 'WORKER_NOT_PROVISIONED' using errcode='55000'; end if;
      if v_provider is null or v_provider not in ('R11','MUSE','GEMINI') then
        raise exception 'provider must be R11, MUSE or GEMINI' using errcode='22023';
      end if;
      insert into agy_shadow.workers(worker_id,provider,role,health,capabilities,permissions,competency,scopes,last_seen_at,last_validated_at)
      values(v_worker_id,v_provider,v_role,'ONLINE',coalesce(p_payload->'capabilities','[]'::jsonb),coalesce(p_payload->'permissions','[]'::jsonb),coalesce(p_payload->'competency','{}'::jsonb),coalesce(p_payload->'scopes','{}'::jsonb),v_now,v_now);
      return jsonb_build_object('status','PASS','worker_id',v_worker_id,'provider',v_provider,'health','ONLINE','provisioned',true,'validated',true);
    end if;

    if v_provider is not null and v_provider <> v_worker.provider then
      raise exception 'WORKER_PROVIDER_MISMATCH' using errcode='23505';
    end if;

    if v_is_control then
      -- CONTROL re-provisioning: scopes/capabilities may be replaced under
      -- change control; provider stays immutable; the touch revalidates.
      update agy_shadow.workers set
        role=v_role, health='ONLINE',
        capabilities=coalesce(p_payload->'capabilities',capabilities),
        permissions=coalesce(p_payload->'permissions',permissions),
        competency=coalesce(p_payload->'competency',competency),
        scopes=coalesce(p_payload->'scopes',scopes),
        last_seen_at=v_now, last_validated_at=v_now, updated_at=v_now
      where worker_id=v_worker_id;
      return jsonb_build_object('status','PASS','worker_id',v_worker_id,'provider',v_worker.provider,'health','ONLINE','provisioned',false,'validated',true);
    end if;

    -- Worker self-call: heartbeat/health declaration ONLY. Any attempt to
    -- widen or alter its own authorization fails closed.
    if (p_payload ? 'capabilities' and p_payload->'capabilities' is distinct from v_worker.capabilities)
       or (p_payload ? 'permissions' and p_payload->'permissions' is distinct from v_worker.permissions)
       or (p_payload ? 'competency' and p_payload->'competency' is distinct from v_worker.competency)
       or (p_payload ? 'scopes' and p_payload->'scopes' is distinct from v_worker.scopes)
       or (p_payload ? 'role' and v_role <> v_worker.role) then
      raise exception 'SCOPE_CHANGE_DENIED' using errcode='55000';
    end if;
    update agy_shadow.workers set health='ONLINE', last_seen_at=v_now, updated_at=v_now where worker_id=v_worker_id;
    return jsonb_build_object('status','PASS','worker_id',v_worker_id,'provider',v_worker.provider,'health','ONLINE','provisioned',false,'validated',v_worker.last_validated_at is not null);
  end if;

  if p_action = 'create_task' then
    if not v_is_control then
      raise exception 'FORBIDDEN_ROLE: task creation is control-plane only' using errcode='22023';
    end if;
    v_mission_id := nullif(p_payload->>'mission_id','');
    v_task_id := nullif(p_payload->>'task_id','');
    v_idempotency_key := nullif(p_payload->>'idempotency_key','');
    v_trace_id := nullif(p_payload->>'trace_id','');
    v_objective := nullif(p_payload->>'objective','');
    if v_mission_id is null or v_task_id is null or v_idempotency_key is null or v_trace_id is null or v_objective is null then
      raise exception 'mission_id, task_id, idempotency_key, trace_id, objective required' using errcode='22023';
    end if;
    if nullif(p_payload->'payload'->>'target_provider','') is not null
       and (p_payload->'payload'->>'target_provider') not in ('R11','MUSE','GEMINI') then
      raise exception 'target_provider must be R11, MUSE or GEMINI' using errcode='22023';
    end if;
    insert into agy_shadow.missions(mission_id,objective,status,source_version,metadata)
    values(v_mission_id,v_objective,'CREATED',p_payload->>'source_version',coalesce(p_payload->'mission_metadata','{}'::jsonb))
    on conflict(mission_id) do nothing;

    insert into agy_shadow.tasks(task_id,mission_id,parent_task_id,status,priority,contract_version,source_version,idempotency_key,trace_id,payload,acceptance_criteria,available_at)
    values(v_task_id,v_mission_id,nullif(p_payload->>'parent_task_id',''),'ROUTED',coalesce((p_payload->>'priority')::integer,100),coalesce(nullif(p_payload->>'contract_version',''),'AGY_TASK_V1'),p_payload->>'source_version',v_idempotency_key,v_trace_id,coalesce(p_payload->'payload','{}'::jsonb),coalesce(p_payload->'acceptance_criteria','{}'::jsonb),coalesce((p_payload->>'available_at')::timestamptz,v_now))
    on conflict(task_id) do nothing;
    get diagnostics v_inserted = row_count;

    select * into v_task from agy_shadow.tasks where task_id=v_task_id;
    if v_task.idempotency_key <> v_idempotency_key or v_task.trace_id <> v_trace_id or v_task.mission_id <> v_mission_id then
      raise exception 'task identity conflict' using errcode='23505';
    end if;
    if not v_inserted and (v_task.payload is distinct from coalesce(p_payload->'payload','{}'::jsonb)
       or v_task.acceptance_criteria is distinct from coalesce(p_payload->'acceptance_criteria','{}'::jsonb)) then
      raise exception 'TASK_CONTENT_CONFLICT' using errcode='23505';
    end if;
    if v_inserted then
      select x into v_queue_msg_id from pgmq.send('agy_tasks_shadow',jsonb_build_object('task_id',v_task_id,'mission_id',v_mission_id,'idempotency_key',v_idempotency_key,'trace_id',v_trace_id)) as x;
      insert into agy_shadow.events(mission_id,task_id,event_type,actor,state_before,state_after,trace_id,evidence)
      values(v_mission_id,v_task_id,'TASK_CREATED','AGY_GATEWAY',null,'ROUTED',v_trace_id,jsonb_build_object('queue_msg_id',v_queue_msg_id));
    end if;
    return jsonb_build_object('status',case when v_inserted then 'CREATED' else 'IDEMPOTENT_REPLAY' end,'task_id',v_task_id,'mission_id',v_mission_id,'queue_msg_id',v_queue_msg_id,'trace_id',v_trace_id);
  end if;

  if p_action = 'claim' then
    raise exception 'claim must use agy_gateway_claim_rpc' using errcode='55000';
  end if;

  if p_action = 'callback' then
    raise exception 'callback must use agy_gateway_callback_rpc' using errcode='55000';
  end if;

  if p_action = 'readback' then
    -- Actual status/result/callback readback. A recorded callback is
    -- reported with its stored status; PENDING is never presented as
    -- delivered or accepted.
    v_task_id := nullif(p_payload->>'task_id','');
    if v_task_id is null then raise exception 'task_id required' using errcode='22023'; end if;
    select * into v_task from agy_shadow.tasks where task_id=v_task_id;
    if not found then raise exception 'task not found' using errcode='P0002'; end if;
    if not v_is_control then
      perform agy_shadow.assert_caller_(p_payload, nullif(p_payload->>'worker_id',''));
      if v_task.assigned_worker is distinct from (p_payload->'_caller'->>'worker_id')
         and not exists(select 1 from agy_shadow.attempts where task_id=v_task_id and worker_id=(p_payload->'_caller'->>'worker_id')) then
        raise exception 'READBACK_DENIED' using errcode='55000';
      end if;
    end if;
    select * into v_result from agy_shadow.results where task_id=v_task_id order by result_version desc limit 1;
    select * into v_callback from agy_shadow.callbacks where task_id=v_task_id order by created_at desc limit 1;
    return jsonb_build_object(
      'task', jsonb_build_object('task_id',v_task.task_id,'mission_id',v_task.mission_id,'status',v_task.status,'assigned_worker',v_task.assigned_worker),
      'result', case when v_result.task_id is null then null else jsonb_build_object('result_version',v_result.result_version,'result_status',v_result.status,'attempt_id',v_result.attempt_id) end,
      'callback', case when v_callback.callback_id is null then null else jsonb_build_object('callback_id',v_callback.callback_id,'target',v_callback.target,'status',v_callback.status,'delivered_at',v_callback.delivered_at) end,
      'callback_semantics','PENDING means recorded only; DELIVERED is set by the control plane after actual delivery and acceptance is a separate QA state');
  end if;

  v_task_id := nullif(p_payload->>'task_id','');
  v_attempt_id := nullif(p_payload->>'attempt_id','');
  v_worker_id := nullif(p_payload->>'worker_id','');
  v_trace_id := nullif(p_payload->>'trace_id','');
  v_idempotency_key := nullif(p_payload->>'idempotency_key','');
  if v_task_id is null or v_attempt_id is null or v_worker_id is null or v_trace_id is null or v_idempotency_key is null then
    raise exception 'task_id, attempt_id, worker_id, trace_id, idempotency_key required' using errcode='22023';
  end if;
  perform agy_shadow.assert_caller_(p_payload, v_worker_id);
  select * into v_task from agy_shadow.tasks where task_id=v_task_id for update;
  if not found then raise exception 'task not found' using errcode='P0002'; end if;
  if v_task.trace_id <> v_trace_id or v_task.idempotency_key <> v_idempotency_key then raise exception 'task identity mismatch' using errcode='22023'; end if;
  select * into v_lease from agy_shadow.leases where task_id=v_task_id for update;
  if not found or v_lease.attempt_id<>v_attempt_id or v_lease.worker_id<>v_worker_id or v_lease.released_at is not null or v_lease.expires_at<=v_now then
    raise exception 'lease invalid or expired' using errcode='55000';
  end if;
  if nullif(p_payload->>'lease_token','') is null or v_lease.lease_token::text<>(p_payload->>'lease_token') or coalesce((p_payload->>'fence')::bigint,0)<>v_lease.fence then
    raise exception 'lease token/fence mismatch' using errcode='55000';
  end if;

  if p_action = 'ack' then
    if v_task.status <> 'LEASED' then raise exception 'invalid transition % -> ACKED',v_task.status using errcode='55000'; end if;
    update agy_shadow.attempts set status='ACKED' where attempt_id=v_attempt_id;
    update agy_shadow.tasks set status='ACKED',updated_at=v_now where task_id=v_task_id;
    insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
    values(v_task.mission_id,v_task_id,v_attempt_id,'TASK_ACKED',v_worker_id,v_task.status,'ACKED',v_trace_id,'{}'::jsonb);
    return jsonb_build_object('status','ACKED','task_id',v_task_id,'attempt_id',v_attempt_id,'fence',v_lease.fence);
  elsif p_action = 'heartbeat' then
    v_lease_seconds := greatest(30,least(coalesce((p_payload->>'lease_seconds')::integer,120),900));
    update agy_shadow.leases set expires_at=v_now+make_interval(secs=>v_lease_seconds) where task_id=v_task_id;
    update agy_shadow.workers set health='ONLINE',last_seen_at=v_now,updated_at=v_now where worker_id=v_worker_id;
    if v_task.status='ACKED' then update agy_shadow.tasks set status='RUNNING',updated_at=v_now where task_id=v_task_id; update agy_shadow.attempts set status='RUNNING' where attempt_id=v_attempt_id; end if;
    return jsonb_build_object('status',case when v_task.status='ACKED' then 'RUNNING' else v_task.status end,'task_id',v_task_id,'attempt_id',v_attempt_id,'expires_at',v_now+make_interval(secs=>v_lease_seconds),'fence',v_lease.fence);
  elsif p_action = 'checkpoint' then
    if v_task.status not in ('ACKED','RUNNING','CHECKPOINTED') then raise exception 'invalid transition % -> CHECKPOINTED',v_task.status using errcode='55000'; end if;
    v_version := coalesce((p_payload->>'version')::integer,0);
    if v_version < 1 then raise exception 'checkpoint version >=1 required' using errcode='22023'; end if;
    insert into agy_shadow.checkpoints(task_id,attempt_id,version,state,evidence)
    values(v_task_id,v_attempt_id,v_version,coalesce(p_payload->'state','{}'::jsonb),coalesce(p_payload->'evidence','{}'::jsonb))
    on conflict(task_id,version) do nothing;
    get diagnostics v_inserted = row_count;
    select * into v_checkpoint from agy_shadow.checkpoints where task_id=v_task_id and version=v_version;
    if v_checkpoint.state is distinct from coalesce(p_payload->'state','{}'::jsonb)
       or v_checkpoint.evidence is distinct from coalesce(p_payload->'evidence','{}'::jsonb)
       or v_checkpoint.attempt_id <> v_attempt_id then
      raise exception 'CHECKPOINT_CONFLICT' using errcode='23505';
    end if;
    update agy_shadow.tasks set status='CHECKPOINTED',updated_at=v_now where task_id=v_task_id;
    update agy_shadow.attempts set status='RUNNING' where attempt_id=v_attempt_id;
    insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
    values(v_task.mission_id,v_task_id,v_attempt_id,'CHECKPOINT_WRITTEN',v_worker_id,v_task.status,'CHECKPOINTED',v_trace_id,jsonb_build_object('version',v_version));
    return jsonb_build_object('status','CHECKPOINTED','task_id',v_task_id,'attempt_id',v_attempt_id,'version',v_version,'fence',v_lease.fence,'replay',not v_inserted);
  elsif p_action = 'result' then
    if v_task.status not in ('ACKED','RUNNING','CHECKPOINTED') then raise exception 'invalid transition % -> RESULT_SUBMITTED',v_task.status using errcode='55000'; end if;
    v_result_version := coalesce((p_payload->>'result_version')::integer,1);
    v_status := nullif(p_payload->>'result_status','');
    if v_status is null then raise exception 'RESULT_STATUS_REQUIRED' using errcode='22023'; end if;
    if v_status not in ('PASS','FAIL','RESULT_READY') then raise exception 'result_status must be PASS, FAIL or RESULT_READY' using errcode='22023'; end if;
    if nullif(p_payload->'evidence'->>'external_operation_id','') is null then
      raise exception 'EVIDENCE_REQUIRED: evidence.external_operation_id' using errcode='22023';
    end if;
    insert into agy_shadow.results(task_id,attempt_id,result_version,status,output,evidence)
    values(v_task_id,v_attempt_id,v_result_version,v_status,coalesce(p_payload->'output','{}'::jsonb),coalesce(p_payload->'evidence','{}'::jsonb))
    on conflict(task_id,result_version) do nothing;
    get diagnostics v_inserted = row_count;
    select * into v_result from agy_shadow.results where task_id=v_task_id and result_version=v_result_version;
    if v_result.status is distinct from v_status
       or v_result.output is distinct from coalesce(p_payload->'output','{}'::jsonb)
       or v_result.evidence is distinct from coalesce(p_payload->'evidence','{}'::jsonb)
       or v_result.attempt_id <> v_attempt_id then
      raise exception 'RESULT_CONFLICT' using errcode='23505';
    end if;
    update agy_shadow.tasks set status='RESULT_SUBMITTED',updated_at=v_now where task_id=v_task_id;
    update agy_shadow.attempts set status='RESULT_SUBMITTED',ended_at=v_now,
      evidence = evidence || jsonb_build_object('callback_authority',
        encode(sha256(convert_to(concat_ws('|', v_task_id, v_attempt_id, v_lease.lease_token::text, v_lease.fence::text, v_result_version::text), 'UTF8')), 'hex'))
      where attempt_id=v_attempt_id;
    update agy_shadow.leases set released_at=v_now where task_id=v_task_id;
    v_queue_msg_id := nullif((select evidence->>'queue_msg_id' from agy_shadow.attempts where attempt_id=v_attempt_id),'')::bigint;
    if v_queue_msg_id is not null then perform pgmq.archive('agy_tasks_shadow',v_queue_msg_id); end if;
    insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
    values(v_task.mission_id,v_task_id,v_attempt_id,'RESULT_SUBMITTED',v_worker_id,v_task.status,'RESULT_SUBMITTED',v_trace_id,jsonb_build_object('result_version',v_result_version,'result_status',v_status));
    return jsonb_build_object('status','RESULT_SUBMITTED','task_id',v_task_id,'attempt_id',v_attempt_id,'result_version',v_result_version,'result_status',v_status,'queue_archived',v_queue_msg_id is not null,'replay',not v_inserted,
      'callback_authority',(select evidence->>'callback_authority' from agy_shadow.attempts where attempt_id=v_attempt_id));
  else
    raise exception 'unsupported action %',p_action using errcode='22023';
  end if;
end;
$function$;

-- ACL preservation (Q3). Live state verified read-only by the control
-- plane: anon and authenticated have no EXECUTE on the three RPCs;
-- service_role does. CREATE OR REPLACE preserves the grants of an existing
-- function, but the statements below make the intended end state explicit
-- and idempotent, and — critically — restrict the NEW helper functions,
-- which Postgres would otherwise grant EXECUTE to PUBLIC by default.
-- Verify after applying:
--   select proname, has_function_privilege('anon', oid, 'EXECUTE') as anon,
--          has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated,
--          has_function_privilege('service_role', oid, 'EXECUTE') as service_role
--   from pg_proc where proname like 'agy_gateway%' or proname like 'assert_%';
revoke execute on function public.agy_gateway_rpc(text, jsonb) from public, anon, authenticated;
revoke execute on function public.agy_gateway_claim_rpc(jsonb) from public, anon, authenticated;
revoke execute on function public.agy_gateway_callback_rpc(jsonb) from public, anon, authenticated;
revoke execute on function agy_shadow.assert_shadow_staging_() from public, anon, authenticated;
revoke execute on function agy_shadow.assert_caller_(jsonb, text) from public, anon, authenticated;
grant execute on function public.agy_gateway_rpc(text, jsonb) to service_role;
grant execute on function public.agy_gateway_claim_rpc(jsonb) to service_role;
grant execute on function public.agy_gateway_callback_rpc(jsonb) to service_role;
grant execute on function agy_shadow.assert_shadow_staging_() to service_role;
grant execute on function agy_shadow.assert_caller_(jsonb, text) to service_role;

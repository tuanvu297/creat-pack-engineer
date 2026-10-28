CREATE OR REPLACE FUNCTION public.agy_gateway_callback_rpc(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_now timestamptz := now();
  v_task agy_shadow.tasks%rowtype;
  v_task_id text := nullif(p_payload->>'task_id','');
  v_attempt_id text := nullif(p_payload->>'attempt_id','');
  v_trace_id text := nullif(p_payload->>'trace_id','');
  v_idempotency_key text := nullif(p_payload->>'idempotency_key','');
  v_callback_id text := nullif(p_payload->>'callback_id','');
  v_status text := coalesce(nullif(p_payload->>'callback_status',''),'PENDING');
begin
  if v_task_id is null or v_attempt_id is null or v_trace_id is null or v_idempotency_key is null or v_callback_id is null then
    raise exception 'task_id, attempt_id, trace_id, idempotency_key, callback_id required' using errcode='22023';
  end if;
  select * into v_task from agy_shadow.tasks where task_id=v_task_id;
  if not found then raise exception 'task not found' using errcode='P0002'; end if;
  if v_task.trace_id<>v_trace_id or v_task.idempotency_key<>v_idempotency_key then raise exception 'task identity mismatch' using errcode='22023'; end if;
  if not exists(select 1 from agy_shadow.attempts where attempt_id=v_attempt_id and task_id=v_task_id) then raise exception 'attempt not found' using errcode='P0002'; end if;
  if not exists(select 1 from agy_shadow.results where task_id=v_task_id and attempt_id=v_attempt_id) then raise exception 'result required before callback' using errcode='55000'; end if;
  insert into agy_shadow.callbacks(callback_id,task_id,attempt_id,target,status,payload,evidence,delivered_at)
  values(v_callback_id,v_task_id,v_attempt_id,coalesce(nullif(p_payload->>'target',''),'CHATGPT_ASSISTANT_CONTROL_PLANE'),v_status,coalesce(p_payload->'callback_payload','{}'::jsonb),coalesce(p_payload->'evidence','{}'::jsonb),case when v_status in ('DELIVERED','ACKED') then v_now else null end)
  on conflict(callback_id) do update set status=excluded.status,payload=excluded.payload,evidence=excluded.evidence,delivered_at=excluded.delivered_at,updated_at=v_now;
  return jsonb_build_object('status',v_status,'callback_id',v_callback_id,'task_id',v_task_id,'attempt_id',v_attempt_id);
end;
$function$


CREATE OR REPLACE FUNCTION public.agy_gateway_claim_rpc(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_now timestamptz := now();
  v_task agy_shadow.tasks%rowtype;
  v_lease agy_shadow.leases%rowtype;
  v_msg pgmq.message_record;
  v_task_id text;
  v_attempt_id text;
  v_worker_id text := nullif(p_payload->>'worker_id','');
  v_provider text := coalesce(nullif(p_payload->>'provider',''),'UNKNOWN');
  v_role text := coalesce(nullif(p_payload->>'role',''),'WORKER');
  v_lease_seconds integer := greatest(30,least(coalesce((p_payload->>'lease_seconds')::integer,120),900));
  v_attempt_no integer;
  v_queue_msg_id bigint;
  v_lease_token uuid;
  v_fence bigint;
  v_lease_exists boolean := false;
begin
  if v_worker_id is null then raise exception 'worker_id required' using errcode='22023'; end if;

  insert into agy_shadow.workers(worker_id,provider,role,health,last_seen_at,last_validated_at)
  values(v_worker_id,v_provider,v_role,'ONLINE',v_now,v_now)
  on conflict(worker_id) do update set provider=excluded.provider,role=excluded.role,health='ONLINE',last_seen_at=v_now,updated_at=v_now;

  select * into v_msg from pgmq.read('agy_tasks_shadow',v_lease_seconds,1) limit 1;
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
  insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
  values(v_task.mission_id,v_task_id,v_attempt_id,'TASK_CLAIMED',v_worker_id,v_task.status,'LEASED',v_task.trace_id,jsonb_build_object('lease_fence',v_fence,'queue_msg_id',v_queue_msg_id));

  return jsonb_build_object('status','LEASED','task_id',v_task_id,'mission_id',v_task.mission_id,'attempt_id',v_attempt_id,'attempt_no',v_attempt_no,'worker_id',v_worker_id,'lease_token',v_lease_token,'fence',v_fence,'expires_at',v_now+make_interval(secs=>v_lease_seconds),'idempotency_key',v_task.idempotency_key,'trace_id',v_task.trace_id,'payload',v_task.payload,'acceptance_criteria',v_task.acceptance_criteria,'queue_msg_id',v_queue_msg_id);
end;
$function$


CREATE OR REPLACE FUNCTION public.agy_gateway_rpc(p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_now timestamptz := now();
  v_task agy_shadow.tasks%rowtype;
  v_lease agy_shadow.leases%rowtype;
  v_msg pgmq.message_record;
  v_task_id text;
  v_mission_id text;
  v_attempt_id text;
  v_worker_id text;
  v_trace_id text;
  v_idempotency_key text;
  v_lease_token uuid;
  v_fence bigint;
  v_lease_seconds integer;
  v_attempt_no integer;
  v_version integer;
  v_result_version integer;
  v_queue_msg_id bigint;
  v_inserted boolean := false;
  v_callback_id text;
  v_status text;
  v_objective text;
  v_provider text;
  v_role text;
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

  if p_action = 'register_worker' then
    v_worker_id := nullif(p_payload->>'worker_id','');
    v_provider := coalesce(nullif(p_payload->>'provider',''),'UNKNOWN');
    v_role := coalesce(nullif(p_payload->>'role',''),'WORKER');
    if v_worker_id is null then raise exception 'worker_id required' using errcode='22023'; end if;
    insert into agy_shadow.workers(worker_id,provider,role,health,capabilities,permissions,competency,last_seen_at,last_validated_at)
    values(v_worker_id,v_provider,v_role,'ONLINE',coalesce(p_payload->'capabilities','{}'::jsonb),coalesce(p_payload->'permissions','{}'::jsonb),coalesce(p_payload->'competency','{}'::jsonb),v_now,v_now)
    on conflict(worker_id) do update set
      provider=excluded.provider,
      role=excluded.role,
      health='ONLINE',
      capabilities=excluded.capabilities,
      permissions=excluded.permissions,
      last_seen_at=v_now,
      updated_at=v_now;
    return jsonb_build_object('status','PASS','worker_id',v_worker_id,'health','ONLINE');
  end if;

  if p_action = 'create_task' then
    v_mission_id := nullif(p_payload->>'mission_id','');
    v_task_id := nullif(p_payload->>'task_id','');
    v_idempotency_key := nullif(p_payload->>'idempotency_key','');
    v_trace_id := nullif(p_payload->>'trace_id','');
    v_objective := nullif(p_payload->>'objective','');
    if v_mission_id is null or v_task_id is null or v_idempotency_key is null or v_trace_id is null or v_objective is null then
      raise exception 'mission_id, task_id, idempotency_key, trace_id, objective required' using errcode='22023';
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
    if v_inserted then
      select x into v_queue_msg_id from pgmq.send('agy_tasks_shadow',jsonb_build_object('task_id',v_task_id,'mission_id',v_mission_id,'idempotency_key',v_idempotency_key,'trace_id',v_trace_id)) as x;
      insert into agy_shadow.events(mission_id,task_id,event_type,actor,state_before,state_after,trace_id,evidence)
      values(v_mission_id,v_task_id,'TASK_CREATED','AGY_GATEWAY',null,'ROUTED',v_trace_id,jsonb_build_object('queue_msg_id',v_queue_msg_id));
    end if;
    return jsonb_build_object('status',case when v_inserted then 'CREATED' else 'IDEMPOTENT_REPLAY' end,'task_id',v_task_id,'mission_id',v_mission_id,'queue_msg_id',v_queue_msg_id,'trace_id',v_trace_id);
  end if;

  if p_action = 'claim' then
    v_worker_id := nullif(p_payload->>'worker_id','');
    v_provider := coalesce(nullif(p_payload->>'provider',''),'UNKNOWN');
    v_role := coalesce(nullif(p_payload->>'role',''),'WORKER');
    v_lease_seconds := greatest(30,least(coalesce((p_payload->>'lease_seconds')::integer,120),900));
    if v_worker_id is null then raise exception 'worker_id required' using errcode='22023'; end if;

    insert into agy_shadow.workers(worker_id,provider,role,health,last_seen_at,last_validated_at)
    values(v_worker_id,v_provider,v_role,'ONLINE',v_now,v_now)
    on conflict(worker_id) do update set health='ONLINE',last_seen_at=v_now,updated_at=v_now;

    select * into v_msg from pgmq.read('agy_tasks_shadow',v_lease_seconds,1) limit 1;
    if v_msg.msg_id is null then return jsonb_build_object('status','EMPTY'); end if;
    v_queue_msg_id := v_msg.msg_id;
    v_task_id := v_msg.message->>'task_id';

    select * into v_task from agy_shadow.tasks where task_id=v_task_id for update;
    if not found then
      perform pgmq.archive('agy_tasks_shadow',v_queue_msg_id);
      return jsonb_build_object('status','ORPHAN_ARCHIVED','queue_msg_id',v_queue_msg_id);
    end if;
    if v_task.status not in ('CREATED','PACKAGED','ROUTED','FAILED_RETRYABLE') or v_task.available_at > v_now then
      return jsonb_build_object('status','NOT_CLAIMABLE','task_id',v_task_id,'task_status',v_task.status);
    end if;

    select * into v_lease from agy_shadow.leases where task_id=v_task_id for update;
    if found and v_lease.released_at is null and v_lease.expires_at > v_now then
      return jsonb_build_object('status','ALREADY_LEASED','task_id',v_task_id,'expires_at',v_lease.expires_at);
    end if;

    v_attempt_no := coalesce((select max(attempt_no)+1 from agy_shadow.attempts where task_id=v_task_id),1);
    v_attempt_id := 'ATT-' || replace(gen_random_uuid()::text,'-','');
    insert into agy_shadow.attempts(attempt_id,task_id,attempt_no,worker_id,status,evidence,started_at)
    values(v_attempt_id,v_task_id,v_attempt_no,v_worker_id,'LEASED',jsonb_build_object('queue_msg_id',v_queue_msg_id),v_now);

    if found then
      update agy_shadow.leases set attempt_id=v_attempt_id,worker_id=v_worker_id,lease_token=gen_random_uuid(),fence=fence+1,acquired_at=v_now,expires_at=v_now+make_interval(secs=>v_lease_seconds),released_at=null where task_id=v_task_id returning lease_token,fence into v_lease_token,v_fence;
    else
      insert into agy_shadow.leases(task_id,attempt_id,worker_id,expires_at)
      values(v_task_id,v_attempt_id,v_worker_id,v_now+make_interval(secs=>v_lease_seconds))
      returning lease_token,fence into v_lease_token,v_fence;
    end if;

    update agy_shadow.tasks set status='LEASED',assigned_worker=v_worker_id,updated_at=v_now where task_id=v_task_id;
    insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
    values(v_task.mission_id,v_task_id,v_attempt_id,'TASK_CLAIMED',v_worker_id,v_task.status,'LEASED',v_task.trace_id,jsonb_build_object('lease_fence',v_fence,'queue_msg_id',v_queue_msg_id));

    return jsonb_build_object('status','LEASED','task_id',v_task_id,'mission_id',v_task.mission_id,'attempt_id',v_attempt_id,'attempt_no',v_attempt_no,'worker_id',v_worker_id,'lease_token',v_lease_token,'fence',v_fence,'expires_at',v_now+make_interval(secs=>v_lease_seconds),'idempotency_key',v_task.idempotency_key,'trace_id',v_task.trace_id,'payload',v_task.payload,'acceptance_criteria',v_task.acceptance_criteria,'queue_msg_id',v_queue_msg_id);
  end if;

  v_task_id := nullif(p_payload->>'task_id','');
  v_attempt_id := nullif(p_payload->>'attempt_id','');
  v_worker_id := nullif(p_payload->>'worker_id','');
  v_trace_id := nullif(p_payload->>'trace_id','');
  v_idempotency_key := nullif(p_payload->>'idempotency_key','');
  if v_task_id is null or v_attempt_id is null or v_worker_id is null or v_trace_id is null or v_idempotency_key is null then
    raise exception 'task_id, attempt_id, worker_id, trace_id, idempotency_key required' using errcode='22023';
  end if;
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
    update agy_shadow.tasks set status='CHECKPOINTED',updated_at=v_now where task_id=v_task_id;
    update agy_shadow.attempts set status='RUNNING' where attempt_id=v_attempt_id;
    insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
    values(v_task.mission_id,v_task_id,v_attempt_id,'CHECKPOINT_WRITTEN',v_worker_id,v_task.status,'CHECKPOINTED',v_trace_id,jsonb_build_object('version',v_version));
    return jsonb_build_object('status','CHECKPOINTED','task_id',v_task_id,'attempt_id',v_attempt_id,'version',v_version,'fence',v_lease.fence);
  elsif p_action = 'result' then
    if v_task.status not in ('ACKED','RUNNING','CHECKPOINTED') then raise exception 'invalid transition % -> RESULT_SUBMITTED',v_task.status using errcode='55000'; end if;
    v_result_version := coalesce((p_payload->>'result_version')::integer,1);
    v_status := coalesce(nullif(p_payload->>'result_status',''),'PASS');
    insert into agy_shadow.results(task_id,attempt_id,result_version,status,output,evidence)
    values(v_task_id,v_attempt_id,v_result_version,v_status,coalesce(p_payload->'output','{}'::jsonb),coalesce(p_payload->'evidence','{}'::jsonb))
    on conflict(task_id,result_version) do nothing;
    update agy_shadow.tasks set status='RESULT_SUBMITTED',updated_at=v_now where task_id=v_task_id;
    update agy_shadow.attempts set status='RESULT_SUBMITTED',ended_at=v_now where attempt_id=v_attempt_id;
    update agy_shadow.leases set released_at=v_now where task_id=v_task_id;
    v_queue_msg_id := nullif((select evidence->>'queue_msg_id' from agy_shadow.attempts where attempt_id=v_attempt_id),'')::bigint;
    if v_queue_msg_id is not null then perform pgmq.archive('agy_tasks_shadow',v_queue_msg_id); end if;
    insert into agy_shadow.events(mission_id,task_id,attempt_id,event_type,actor,state_before,state_after,trace_id,evidence)
    values(v_task.mission_id,v_task_id,v_attempt_id,'RESULT_SUBMITTED',v_worker_id,v_task.status,'RESULT_SUBMITTED',v_trace_id,jsonb_build_object('result_version',v_result_version,'result_status',v_status));
    return jsonb_build_object('status','RESULT_SUBMITTED','task_id',v_task_id,'attempt_id',v_attempt_id,'result_version',v_result_version,'result_status',v_status,'queue_archived',v_queue_msg_id is not null);
  elsif p_action = 'callback' then
    v_callback_id := nullif(p_payload->>'callback_id','');
    if v_callback_id is null then raise exception 'callback_id required' using errcode='22023'; end if;
    v_status := coalesce(nullif(p_payload->>'callback_status',''),'PENDING');
    insert into agy_shadow.callbacks(callback_id,task_id,attempt_id,target,status,payload,evidence,delivered_at)
    values(v_callback_id,v_task_id,v_attempt_id,coalesce(nullif(p_payload->>'target',''),'CHATGPT_ASSISTANT_CONTROL_PLANE'),v_status,coalesce(p_payload->'callback_payload','{}'::jsonb),coalesce(p_payload->'evidence','{}'::jsonb),case when v_status in ('DELIVERED','ACKED') then v_now else null end)
    on conflict(callback_id) do update set status=excluded.status,payload=excluded.payload,evidence=excluded.evidence,delivered_at=excluded.delivered_at,updated_at=v_now;
    return jsonb_build_object('status',v_status,'callback_id',v_callback_id,'task_id',v_task_id,'attempt_id',v_attempt_id);
  else
    raise exception 'unsupported action %',p_action using errcode='22023';
  end if;
end;
$function$


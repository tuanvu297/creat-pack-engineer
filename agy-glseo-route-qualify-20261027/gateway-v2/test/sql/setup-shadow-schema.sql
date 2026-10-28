-- LOCAL TEST SETUP for the gateway RPC candidate tests.
-- Evidence class: LOCAL integration harness. The agy_shadow DDL below is
-- INFERRED from the deployed RPC source (the real shadow schema lives in
-- Supabase and is not in the repo migrations); column sets are exactly the
-- ones the three RPCs read and write. pgmq here is a minimal local TEST
-- DOUBLE implementing read/send/archive with visibility-timeout semantics —
-- it is not the real pgmq extension and proves nothing about it.

create schema if not exists agy_shadow;
create schema if not exists pgmq;

create type pgmq.message_record as (
  msg_id bigint, read_ct int, enqueued_at timestamptz, vt timestamptz, message jsonb
);
create table if not exists pgmq.q_agy_tasks_shadow (
  msg_id bigserial primary key, message jsonb not null,
  read_ct int not null default 0,
  vt_until timestamptz not null default now(),
  enqueued_at timestamptz not null default now()
);
create or replace function pgmq.read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record language plpgsql as $fn$
begin
  if queue_name <> 'agy_tasks_shadow' then raise exception 'unknown queue %', queue_name; end if;
  return query
    update pgmq.q_agy_tasks_shadow q
       set vt_until = now() + make_interval(secs => vt), read_ct = q.read_ct + 1
     where q.msg_id in (select msg_id from pgmq.q_agy_tasks_shadow where vt_until <= now() order by msg_id limit qty)
    returning q.msg_id, q.read_ct, q.enqueued_at, q.vt_until, q.message;
end;
$fn$;
create or replace function pgmq.send(queue_name text, message jsonb)
returns bigint language plpgsql as $fn$
declare v_id bigint;
begin
  if queue_name <> 'agy_tasks_shadow' then raise exception 'unknown queue %', queue_name; end if;
  insert into pgmq.q_agy_tasks_shadow(message) values (message) returning msg_id into v_id;
  return v_id;
end;
$fn$;
create or replace function pgmq.archive(queue_name text, p_msg_id bigint)
returns boolean language plpgsql as $fn$
begin
  if queue_name <> 'agy_tasks_shadow' then raise exception 'unknown queue %', queue_name; end if;
  delete from pgmq.q_agy_tasks_shadow q where q.msg_id = p_msg_id;
  return found;
end;
$fn$;

create table agy_shadow.schema_meta (key text primary key, value jsonb not null);
insert into agy_shadow.schema_meta(key, value)
values ('state_plane', '{"mode":"SHADOW_STAGING","schema_version":"candidate-test"}'::jsonb);

create table agy_shadow.missions (
  mission_id text primary key, objective text, status text, source_version text,
  metadata jsonb not null default '{}'::jsonb
);
create table agy_shadow.workers (
  worker_id text primary key, provider text not null, role text not null default 'WORKER',
  health text, capabilities jsonb not null default '{}'::jsonb,
  permissions jsonb not null default '{}'::jsonb, competency jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz, last_validated_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table agy_shadow.tasks (
  task_id text primary key, mission_id text not null, parent_task_id text,
  status text not null, priority integer, contract_version text, source_version text,
  idempotency_key text not null, trace_id text not null,
  payload jsonb not null default '{}'::jsonb, acceptance_criteria jsonb not null default '{}'::jsonb,
  available_at timestamptz not null default now(), assigned_worker text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table agy_shadow.attempts (
  attempt_id text primary key, task_id text not null, attempt_no integer not null,
  worker_id text, status text, evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz, ended_at timestamptz
);
create table agy_shadow.leases (
  task_id text primary key, attempt_id text, worker_id text,
  lease_token uuid not null default gen_random_uuid(), fence bigint not null default 1,
  acquired_at timestamptz not null default now(), expires_at timestamptz, released_at timestamptz
);
create table agy_shadow.checkpoints (
  task_id text not null, attempt_id text, version integer not null,
  state jsonb, evidence jsonb, primary key (task_id, version)
);
create table agy_shadow.results (
  task_id text not null, attempt_id text, result_version integer not null,
  status text, output jsonb, evidence jsonb, primary key (task_id, result_version)
);
create table agy_shadow.callbacks (
  callback_id text primary key, task_id text, attempt_id text, target text, status text,
  payload jsonb, evidence jsonb, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table agy_shadow.events (
  id bigserial primary key, mission_id text, task_id text, attempt_id text,
  event_type text, actor text, state_before text, state_after text, trace_id text, evidence jsonb
);

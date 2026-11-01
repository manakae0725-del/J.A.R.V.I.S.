-- Durable background task storage. Applied to the linked Supabase project as
-- migration create_jarvis_background_task_system (2026-11-01).
create table if not exists public.jarvis_background_tasks (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 title text not null default 'バックグラウンドタスク',
 request text not null,
 idempotency_key text not null,
 status text not null default 'queued' check (status in ('queued','planning','running','verifying','retrying','paused','completed','failed','cancelled')),
 plan jsonb not null default '[]'::jsonb,
 current_step integer not null default 0 check (current_step >= 0),
 progress integer not null default 0 check (progress between 0 and 100),
 result jsonb,
 error_code text,
 error_message text,
 attempt_count integer not null default 0 check (attempt_count >= 0),
 max_attempts integer not null default 4 check (max_attempts between 1 and 10),
 run_after timestamptz not null default now(),
 worker_id text,
 lease_expires_at timestamptz,
 heartbeat_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 started_at timestamptz,
 completed_at timestamptz,
 unique(user_id,idempotency_key)
);
create index if not exists jarvis_background_tasks_queue_idx on public.jarvis_background_tasks(run_after,created_at) where status in ('queued','retrying','running');
create index if not exists jarvis_background_tasks_user_idx on public.jarvis_background_tasks(user_id,created_at desc);

create table if not exists public.jarvis_background_task_steps (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.jarvis_background_tasks(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 step_index integer not null check(step_index >= 0),
 title text not null,
 instruction text not null,
 status text not null default 'pending' check(status in ('pending','running','completed','failed','skipped')),
 output jsonb,
 error_code text,
 attempt_count integer not null default 0,
 started_at timestamptz,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(task_id,step_index)
);
create index if not exists jarvis_background_task_steps_task_idx on public.jarvis_background_task_steps(task_id,step_index);

create table if not exists public.jarvis_background_task_events (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.jarvis_background_tasks(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 event_type text not null,
 message text not null,
 payload jsonb not null default '{}'::jsonb,
 read_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists jarvis_background_task_events_user_idx on public.jarvis_background_task_events(user_id,created_at desc);

alter table public.jarvis_background_tasks enable row level security;
alter table public.jarvis_background_task_steps enable row level security;
alter table public.jarvis_background_task_events enable row level security;
revoke all on public.jarvis_background_tasks,public.jarvis_background_task_steps,public.jarvis_background_task_events from anon,authenticated;
grant all on public.jarvis_background_tasks,public.jarvis_background_task_steps,public.jarvis_background_task_events to service_role;

create or replace function public.jarvis_enqueue_background_task(p_user_id uuid,p_request text,p_title text,p_idempotency_key text)
returns public.jarvis_background_tasks language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task public.jarvis_background_tasks;
begin
 if p_user_id is null or p_request is null or length(btrim(p_request))=0 or length(p_request)>12000 or p_idempotency_key is null or length(p_idempotency_key)<8 or length(p_idempotency_key)>128 then raise exception 'INVALID_BACKGROUND_TASK_INPUT'; end if;
 insert into public.jarvis_background_tasks(user_id,request,title,idempotency_key)
 values(p_user_id,btrim(p_request),coalesce(nullif(btrim(p_title),''),'バックグラウンドタスク'),p_idempotency_key)
 on conflict(user_id,idempotency_key) do nothing returning * into v_task;
 if v_task.id is null then select * into v_task from public.jarvis_background_tasks where user_id=p_user_id and idempotency_key=p_idempotency_key;
 else insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(v_task.id,p_user_id,'created','タスクを受け付けました。'); end if;
 return v_task;
end; $$;

create or replace function public.jarvis_claim_background_task(p_worker_id text,p_lease_seconds integer default 120)
returns setof public.jarvis_background_tasks language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_worker_id is null or length(btrim(p_worker_id))<8 then raise exception 'INVALID_WORKER_ID'; end if;
 update public.jarvis_background_tasks set status='failed',error_code='MAX_ATTEMPTS_EXCEEDED',error_message='実行回数の上限に達したため停止しました。',completed_at=now(),worker_id=null,lease_expires_at=null,updated_at=now()
 where status='running' and lease_expires_at<now() and attempt_count>=max_attempts;
 return query with candidate as (
  select id from public.jarvis_background_tasks
  where (status in ('queued','retrying') and run_after<=now()) or (status='running' and lease_expires_at<now() and attempt_count<max_attempts)
  order by run_after,created_at for update skip locked limit 1
 )
 update public.jarvis_background_tasks t set status=case when jsonb_array_length(t.plan)=0 then 'planning' else 'running' end,
 attempt_count=t.attempt_count+1,worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),heartbeat_at=now(),started_at=coalesce(t.started_at,now()),updated_at=now()
 from candidate c where t.id=c.id returning t.*;
end; $$;

create or replace function public.jarvis_save_background_task_plan(p_task_id uuid,p_worker_id text,p_plan jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task public.jarvis_background_tasks; v_item jsonb; v_index integer:=0;
begin
 select * into v_task from public.jarvis_background_tasks where id=p_task_id and status='planning' and worker_id=p_worker_id for update;
 if v_task.id is null then return false; end if;
 if jsonb_typeof(p_plan)<>'array' or jsonb_array_length(p_plan)<1 or jsonb_array_length(p_plan)>5 then raise exception 'INVALID_BACKGROUND_TASK_PLAN'; end if;
 delete from public.jarvis_background_task_steps where task_id=p_task_id;
 for v_item in select value from jsonb_array_elements(p_plan) loop
  if jsonb_typeof(v_item)<>'object' or coalesce(length(v_item->>'title'),0)=0 or coalesce(length(v_item->>'instruction'),0)=0 then raise exception 'INVALID_BACKGROUND_TASK_STEP'; end if;
  insert into public.jarvis_background_task_steps(task_id,user_id,step_index,title,instruction) values(p_task_id,v_task.user_id,v_index,left(v_item->>'title',160),left(v_item->>'instruction',4000));
  v_index:=v_index+1;
 end loop;
 update public.jarvis_background_tasks set plan=p_plan,current_step=0,progress=0,status='queued',worker_id=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now() where id=p_task_id;
 insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(p_task_id,v_task.user_id,'planned','作業計画を作成しました。');
 return true;
end; $$;

create or replace function public.jarvis_save_background_task_step(p_task_id uuid,p_worker_id text,p_step_index integer,p_output jsonb,p_progress integer,p_next_status text default 'queued')
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task public.jarvis_background_tasks; v_step public.jarvis_background_task_steps;
begin
 if p_next_status not in ('queued','verifying') then raise exception 'INVALID_NEXT_TASK_STATUS'; end if;
 select * into v_task from public.jarvis_background_tasks where id=p_task_id and status='running' and worker_id=p_worker_id for update;
 if v_task.id is null then return false; end if;
 select * into v_step from public.jarvis_background_task_steps where task_id=p_task_id and step_index=p_step_index for update;
 if v_step.id is null then return false; end if;
 update public.jarvis_background_task_steps set status='completed',output=p_output,attempt_count=attempt_count+1,completed_at=now(),updated_at=now() where id=v_step.id;
 update public.jarvis_background_tasks set current_step=greatest(current_step,p_step_index+1),progress=greatest(0,least(coalesce(p_progress,0),99)),status=p_next_status,worker_id=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now() where id=p_task_id;
 insert into public.jarvis_background_task_events(task_id,user_id,event_type,message,payload) values(p_task_id,v_task.user_id,'step_completed','作業ステップが完了しました。',jsonb_build_object('step_index',p_step_index,'progress',p_progress));
 return true;
end; $$;

create or replace function public.jarvis_finish_background_task(p_task_id uuid,p_worker_id text,p_status text,p_result jsonb default null,p_error_code text default null,p_error_message text default null,p_run_after timestamptz default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task public.jarvis_background_tasks;
begin
 if p_status not in ('completed','failed','retrying','paused') then raise exception 'INVALID_FINAL_TASK_STATUS'; end if;
 select * into v_task from public.jarvis_background_tasks where id=p_task_id and worker_id=p_worker_id for update;
 if v_task.id is null then return false; end if;
 update public.jarvis_background_tasks set status=p_status,result=coalesce(p_result,result),error_code=p_error_code,error_message=p_error_message,run_after=coalesce(p_run_after,run_after),progress=case when p_status='completed' then 100 else progress end,completed_at=case when p_status in ('completed','failed') then now() else null end,worker_id=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now() where id=p_task_id;
 insert into public.jarvis_background_task_events(task_id,user_id,event_type,message,payload) values(p_task_id,v_task.user_id,p_status,case p_status when 'completed' then 'バックグラウンド作業が完了しました。' when 'failed' then 'バックグラウンド作業でエラーが発生しました。' when 'retrying' then '作業を再試行します。' else '作業を一時停止しました。' end,jsonb_build_object('error_code',p_error_code));
 return true;
end; $$;

create or replace function public.jarvis_cancel_background_task(p_user_id uuid,p_task_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rows integer;
begin
 update public.jarvis_background_tasks set status='cancelled',worker_id=null,lease_expires_at=null,completed_at=now(),updated_at=now()
 where id=p_task_id and user_id=p_user_id and status in ('queued','planning','running','verifying','retrying','paused');
 get diagnostics v_rows=row_count;
 if v_rows>0 then insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(p_task_id,p_user_id,'cancelled','タスクをキャンセルしました。'); end if;
 return v_rows>0;
end; $$;

revoke all on function public.jarvis_enqueue_background_task(uuid,text,text,text),public.jarvis_claim_background_task(text,integer),public.jarvis_save_background_task_plan(uuid,text,jsonb),public.jarvis_save_background_task_step(uuid,text,integer,jsonb,integer,text),public.jarvis_finish_background_task(uuid,text,text,jsonb,text,text,timestamptz),public.jarvis_cancel_background_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.jarvis_enqueue_background_task(uuid,text,text,text),public.jarvis_claim_background_task(text,integer),public.jarvis_save_background_task_plan(uuid,text,jsonb),public.jarvis_save_background_task_step(uuid,text,integer,jsonb,integer,text),public.jarvis_finish_background_task(uuid,text,text,jsonb,text,text,timestamptz),public.jarvis_cancel_background_task(uuid,uuid) to service_role;

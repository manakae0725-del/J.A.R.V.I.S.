-- Keep an active worker lease through pause/resume so an in-flight stage
-- cannot overlap with a newly resumed worker.
create or replace function public.jarvis_pause_background_task(p_user_id uuid,p_task_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rows integer;
begin
 update public.jarvis_background_tasks set status='paused',updated_at=now()
 where id=p_task_id and user_id=p_user_id and status in ('queued','planning','running','verifying','retrying');
 get diagnostics v_rows=row_count;
 if v_rows>0 then insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(p_task_id,p_user_id,'paused','タスクを一時停止しました。'); end if;
 return v_rows>0;
end; $$;

create or replace function public.jarvis_resume_background_task(p_user_id uuid,p_task_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rows integer;
begin
 update public.jarvis_background_tasks set status='queued',run_after=now(),error_code=null,error_message=null,completed_at=null,updated_at=now()
 where id=p_task_id and user_id=p_user_id and status='paused';
 get diagnostics v_rows=row_count;
 if v_rows>0 then insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(p_task_id,p_user_id,'resumed','タスクを再開しました。'); end if;
 return v_rows>0;
end; $$;

create or replace function public.jarvis_release_background_task_lease(p_task_id uuid,p_worker_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rows integer;
begin
 update public.jarvis_background_tasks set worker_id=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now()
 where id=p_task_id and worker_id=p_worker_id and status in ('paused','queued');
 get diagnostics v_rows=row_count;
 return v_rows>0;
end; $$;

create or replace function public.jarvis_claim_background_task(p_worker_id text,p_lease_seconds integer default 120)
returns setof public.jarvis_background_tasks language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_worker_id is null or length(btrim(p_worker_id))<8 then raise exception 'INVALID_WORKER_ID'; end if;
 update public.jarvis_background_tasks set status='failed',error_code='MAX_ATTEMPTS_EXCEEDED',error_message='ワーカーが繰り返し停止したため、安全のため実行を停止しました。',completed_at=now(),worker_id=null,lease_expires_at=null,updated_at=now()
 where status='running' and lease_expires_at<now() and attempt_count>=max_attempts;
 return query with candidate as (
  select id,status as previous_status from public.jarvis_background_tasks
  where ((status in ('queued','retrying') and run_after<=now() and (lease_expires_at is null or lease_expires_at<now()))
    or (status='running' and lease_expires_at<now() and attempt_count<max_attempts))
  order by run_after,created_at for update skip locked limit 1
 )
 update public.jarvis_background_tasks t set status=case when jsonb_array_length(t.plan)=0 then 'planning' else 'running' end,
 attempt_count=case when c.previous_status='running' then t.attempt_count+1 else t.attempt_count end,
 worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),
 heartbeat_at=now(),started_at=coalesce(t.started_at,now()),updated_at=now()
 from candidate c where t.id=c.id returning t.*;
end; $$;

revoke all on function public.jarvis_release_background_task_lease(uuid,text) from public,anon,authenticated;
grant execute on function public.jarvis_release_background_task_lease(uuid,text) to service_role;

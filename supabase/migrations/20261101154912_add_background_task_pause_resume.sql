create or replace function public.jarvis_pause_background_task(p_user_id uuid,p_task_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rows integer;
begin
 update public.jarvis_background_tasks set status='paused',worker_id=null,lease_expires_at=null,updated_at=now()
 where id=p_task_id and user_id=p_user_id and status in ('queued','planning','running','verifying','retrying');
 get diagnostics v_rows=row_count;
 if v_rows>0 then insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(p_task_id,p_user_id,'paused','タスクを一時停止しました。'); end if;
 return v_rows>0;
end; $$;

create or replace function public.jarvis_resume_background_task(p_user_id uuid,p_task_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rows integer;
begin
 update public.jarvis_background_tasks set status='queued',run_after=now(),worker_id=null,lease_expires_at=null,error_code=null,error_message=null,completed_at=null,updated_at=now()
 where id=p_task_id and user_id=p_user_id and status='paused';
 get diagnostics v_rows=row_count;
 if v_rows>0 then insert into public.jarvis_background_task_events(task_id,user_id,event_type,message) values(p_task_id,p_user_id,'resumed','タスクを再開しました。'); end if;
 return v_rows>0;
end; $$;

revoke all on function public.jarvis_pause_background_task(uuid,uuid),public.jarvis_resume_background_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.jarvis_pause_background_task(uuid,uuid),public.jarvis_resume_background_task(uuid,uuid) to service_role;

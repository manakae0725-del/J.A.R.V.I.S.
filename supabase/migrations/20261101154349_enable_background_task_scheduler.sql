-- Scheduler and bounded verification-loop support for background tasks.
create extension if not exists pg_cron;
create extension if not exists pg_net;
alter table public.jarvis_background_tasks add column if not exists verification_attempts integer not null default 0 check(verification_attempts between 0 and 3);

create or replace function public.jarvis_claim_background_task(p_worker_id text,p_lease_seconds integer default 120)
returns setof public.jarvis_background_tasks language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_worker_id is null or length(btrim(p_worker_id))<8 then raise exception 'INVALID_WORKER_ID'; end if;
 update public.jarvis_background_tasks set status='failed',error_code='MAX_ATTEMPTS_EXCEEDED',error_message='ワーカーが繰り返し停止したため、安全のため実行を停止しました。',completed_at=now(),worker_id=null,lease_expires_at=null,updated_at=now()
 where status='running' and lease_expires_at<now() and attempt_count>=max_attempts;
 return query with candidate as (
  select id,status as previous_status from public.jarvis_background_tasks
  where (status in ('queued','retrying') and run_after<=now()) or (status='running' and lease_expires_at<now() and attempt_count<max_attempts)
  order by run_after,created_at for update skip locked limit 1
 )
 update public.jarvis_background_tasks t set status=case when jsonb_array_length(t.plan)=0 then 'planning' else 'running' end,
 attempt_count=case when c.previous_status='running' then t.attempt_count+1 else t.attempt_count end,
 worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),
 heartbeat_at=now(),started_at=coalesce(t.started_at,now()),updated_at=now()
 from candidate c where t.id=c.id returning t.*;
end; $$;

create or replace function public.jarvis_append_background_task_correction(p_task_id uuid,p_worker_id text,p_title text,p_instruction text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task public.jarvis_background_tasks; v_next_index integer;
begin
 select * into v_task from public.jarvis_background_tasks where id=p_task_id and status='running' and worker_id=p_worker_id for update;
 if v_task.id is null or v_task.verification_attempts>=2 or jsonb_array_length(v_task.plan)>=7 then return false; end if;
 if p_title is null or length(btrim(p_title))=0 or p_instruction is null or length(btrim(p_instruction))=0 then raise exception 'INVALID_CORRECTION_STEP'; end if;
 v_next_index:=jsonb_array_length(v_task.plan);
 insert into public.jarvis_background_task_steps(task_id,user_id,step_index,title,instruction)
 values(p_task_id,v_task.user_id,v_next_index,left(btrim(p_title),160),left(btrim(p_instruction),4000));
 update public.jarvis_background_tasks set plan=plan||jsonb_build_array(jsonb_build_object('title',left(btrim(p_title),160),'instruction',left(btrim(p_instruction),4000))),
 current_step=v_next_index,verification_attempts=verification_attempts+1,progress=least(progress,90),status='queued',worker_id=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now()
 where id=p_task_id;
 insert into public.jarvis_background_task_events(task_id,user_id,event_type,message,payload)
 values(p_task_id,v_task.user_id,'correction_added','検証結果に基づき修正ステップを追加しました。',jsonb_build_object('step_index',v_next_index));
 return true;
end; $$;
revoke all on function public.jarvis_append_background_task_correction(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.jarvis_append_background_task_correction(uuid,text,text,text) to service_role;

-- Recreate the currently observed one-minute recovery job on a clean database.
-- The job calls the Preview worker only; secrets are read from Supabase Vault.
do $migration$
begin
  if not exists (
    select 1 from cron.job where jobname = 'jarvis-background-worker'
  ) then
    perform cron.schedule(
      'jarvis-background-worker',
      '* * * * *',
      $job$
        select net.http_post(
          url := 'https://j-a-r-v-i-s-git-perf-response-speed-memory-cache-manato2.vercel.app/api/gemini',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-jarvis-worker-secret',
            (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_background_worker_secret' limit 1),
            'x-vercel-protection-bypass',
            (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_vercel_protection_bypass' limit 1)
          ),
          body := '{"mode":"background-worker-tick"}'::jsonb,
          timeout_milliseconds := 45000
        ) as request_id;
      $job$
    );
  end if;
end;
$migration$;

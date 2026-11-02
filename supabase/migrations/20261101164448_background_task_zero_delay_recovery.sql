-- Reconstructed from public.jarvis_retry_background_task on 2026-11-02.
-- The live definition clamps retry delay to 0..60 seconds and defaults to zero.
create or replace function public.jarvis_retry_background_task(
  p_task_id uuid,
  p_worker_id text,
  p_error_code text default 'BACKGROUND_TASK_EXECUTION_FAILED',
  p_error_message text default '一時的な処理エラーが発生しました。',
  p_retry_delay_seconds integer default 0
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_task public.jarvis_background_tasks;
  v_attempt integer;
  v_next_status text;
  v_delay integer;
begin
  select * into v_task
  from public.jarvis_background_tasks
  where id = p_task_id
    and worker_id = p_worker_id
    and status in ('planning', 'running')
  for update;

  if v_task.id is null then return null; end if;

  v_attempt := coalesce(v_task.attempt_count, 0) + 1;
  v_delay := greatest(0, least(coalesce(p_retry_delay_seconds, 0), 60));

  if v_attempt >= greatest(1, coalesce(v_task.max_attempts, 3)) then
    v_next_status := 'failed';
    update public.jarvis_background_tasks
    set status = 'failed',
        attempt_count = v_attempt,
        error_code = left(coalesce(p_error_code, 'BACKGROUND_TASK_EXECUTION_FAILED'), 100),
        error_message = left(coalesce(p_error_message, '処理に失敗しました。'), 500),
        completed_at = now(),
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = now(),
        updated_at = now()
    where id = p_task_id;
  else
    v_next_status := 'retrying';
    update public.jarvis_background_tasks
    set status = 'retrying',
        attempt_count = v_attempt,
        error_code = left(coalesce(p_error_code, 'BACKGROUND_TASK_EXECUTION_FAILED'), 100),
        error_message = left(coalesce(p_error_message, '一時的な処理エラーが発生しました。'), 500),
        run_after = now() + make_interval(secs => v_delay),
        completed_at = null,
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = now(),
        updated_at = now()
    where id = p_task_id;
  end if;

  insert into public.jarvis_background_task_events
    (task_id, user_id, event_type, message, payload)
  values (
    p_task_id,
    v_task.user_id,
    v_next_status,
    case when v_next_status = 'retrying'
      then '一時的なエラーを検知したため、自動再試行します。'
      else '再試行上限に達したため、作業を停止しました。'
    end,
    jsonb_build_object(
      'error_code', left(coalesce(p_error_code, 'BACKGROUND_TASK_EXECUTION_FAILED'), 100),
      'attempt_count', v_attempt,
      'retry_delay_seconds', case when v_next_status = 'retrying' then v_delay else null end
    )
  );

  return v_next_status;
end;
$function$;

revoke all on function public.jarvis_retry_background_task(uuid,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.jarvis_retry_background_task(uuid,text,text,text,integer)
  to service_role;

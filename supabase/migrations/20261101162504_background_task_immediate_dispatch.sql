-- Immediately dispatch the next Preview worker after a task enters the runnable queue.
-- The existing one-minute pg_cron job remains as a recovery/fallback mechanism.
-- All requests continue to use the dedicated Preview-only worker and Vercel protection secrets.

create or replace function public.jarvis_dispatch_background_worker()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker_secret text;
  v_vercel_bypass text;
begin
  select decrypted_secret into v_worker_secret
  from vault.decrypted_secrets
  where name = 'jarvis_background_worker_secret'
  limit 1;

  select decrypted_secret into v_vercel_bypass
  from vault.decrypted_secrets
  where name = 'jarvis_vercel_protection_bypass'
  limit 1;

  if coalesce(v_worker_secret, '') = '' or coalesce(v_vercel_bypass, '') = '' then
    raise exception 'BACKGROUND_WORKER_DISPATCH_CONFIG_MISSING';
  end if;

  perform net.http_post(
    url := 'https://j-a-r-v-i-s-git-perf-response-speed-memory-cache-manato2.vercel.app/api/gemini',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-jarvis-worker-secret', v_worker_secret,
      'x-vercel-protection-bypass', v_vercel_bypass
    ),
    body := jsonb_build_object('mode', 'background-worker-tick'),
    timeout_milliseconds := 45000
  );
end;
$$;

revoke all on function public.jarvis_dispatch_background_worker() from public, anon, authenticated;
grant execute on function public.jarvis_dispatch_background_worker() to service_role;

create or replace function public.jarvis_background_task_dispatch_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.jarvis_dispatch_background_worker();
  return new;
exception when others then
  -- Do not fail task persistence if immediate dispatch is temporarily unavailable.
  -- The existing pg_cron worker will recover queued tasks.
  raise warning 'Background worker immediate dispatch failed (SQLSTATE %)', SQLSTATE;
  return new;
end;
$$;

revoke all on function public.jarvis_background_task_dispatch_trigger() from public, anon, authenticated;

drop trigger if exists jarvis_background_task_dispatch_on_insert
  on public.jarvis_background_tasks;
create trigger jarvis_background_task_dispatch_on_insert
after insert on public.jarvis_background_tasks
for each row
when (new.status in ('queued', 'retrying'))
execute function public.jarvis_background_task_dispatch_trigger();

drop trigger if exists jarvis_background_task_dispatch_on_status
  on public.jarvis_background_tasks;
create trigger jarvis_background_task_dispatch_on_status
after update of status on public.jarvis_background_tasks
for each row
when (
  old.status is distinct from new.status
  and new.status in ('queued', 'retrying')
)
execute function public.jarvis_background_task_dispatch_trigger();

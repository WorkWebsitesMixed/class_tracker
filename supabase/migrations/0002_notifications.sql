-- =============================================================================
-- Notifications: end-of-block push, fired by pg_cron -> Edge Function.
-- =============================================================================

-- Track when a session was notified so the cron never double-sends.
alter table class_sessions add column notified_at timestamptz;

-- Sessions that ended recently, are still unreported, and not yet notified.
-- The Edge Function reads this (service role) instead of duplicating the logic.
create or replace function sessions_to_notify(p_window_minutes int default 20)
returns table (
  session_id   uuid,
  teacher_id   uuid,
  subject_name text,
  cycle_name   text,
  scheduled_end timestamptz
)
language sql stable as $$
  select s.id, l.teacher_id, sub.name, c.name, s.scheduled_end
  from class_sessions s
  join lessons  l   on l.id = s.lesson_id
  join subjects sub on sub.id = l.subject_id
  join cycles   c   on c.id = l.cycle_id
  where s.state = 'pending'
    and s.notified_at is null
    and s.scheduled_end <= now()
    and s.scheduled_end >= now() - make_interval(mins => p_window_minutes);
$$;

-- =============================================================================
-- pg_cron schedule (run once, after setting the secrets below).
-- pg_cron runs in UTC; we schedule every 5 min ALL day and let
-- sessions_to_notify() filter by real end-times — TZ-safe and idempotent.
--
-- One-time secret setup (Supabase SQL editor or vault UI):
--   select vault.create_secret('https://<ref>.functions.supabase.co/notify-block-end', 'notify_edge_url');
--   select vault.create_secret('<service_role_key>', 'notify_service_key');
-- =============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Wrapped in a function so the schedule body stays readable.
create or replace function trigger_block_end_notify()
returns void language plpgsql security definer as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'notify_edge_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'notify_service_key';
  if v_url is null then return; end if;     -- not configured yet; no-op
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb
  );
end;
$$;

-- Schedule it (no-op until the secrets exist):
select cron.schedule('notify-block-end', '*/5 * * * *', $$select trigger_block_end_notify();$$);

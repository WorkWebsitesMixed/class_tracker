-- =============================================================================
-- Class Tracker — initial schema
-- Postgres / Supabase. Maps aSc Horarios exports + master academic calendar.
--
-- Timetables are VERSIONED: the teacher schedule (incl. class times) changes a
-- few times a year. Each import creates a schedule_version with an effective
-- date range. Past/reported sessions stay linked to the version that was active
-- then, so history is never corrupted; only future un-reported sessions are
-- regenerated when a schedule changes. Room changes are cheap (edit the lesson).
-- =============================================================================

create extension if not exists citext;
create extension if not exists btree_gist;   -- for the no-overlap exclusion constraint

-- ---------- Enums ------------------------------------------------------------
create type user_role     as enum ('teacher', 'coordinator', 'admin');
create type day_type      as enum ('class', 'holiday', 'exam', 'event', 'weekend');
create type session_state as enum ('pending', 'reported', 'cancelled');
create type report_status as enum ('given', 'missed');
create type report_source as enum ('app', 'notification', 'admin');

-- ---------- Dimensions (from aSc Horarios) -----------------------------------
create table academic_years (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                 -- e.g. "2026-2027"
  start_date  date not null,
  end_date    date not null,
  is_active   boolean not null default true
);

create table teachers (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique,      -- the OAuth link key (Google Workspace)
  full_name      text not null,
  asc_short_name text,
  role           user_role not null default 'teacher',
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

create table subjects (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  asc_code text unique
);

create table rooms (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  asc_code text unique
);

create table cycles (              -- class groups / grade sections, e.g. "10-A"
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  asc_code text unique
);

-- Block labels for sorting/displaying cards. NOT authoritative for times —
-- times live on the lesson, because they can differ between schedule versions.
create table periods (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,        -- e.g. "Block 1"
  sort_order int  not null unique
);

-- ---------- Master academic calendar (from the .xlsx) ------------------------
-- This school runs a ROTATING day cycle (DAY 1..DAY 5) that skips holidays,
-- not a fixed Mon-Fri week. cycle_day maps each physical date to its rotation
-- day; it is null on non-teaching days (holidays/events/"DAY 0").
create table calendar_days (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years(id) on delete cascade,
  date             date not null,
  day_type         day_type not null default 'class',
  cycle_day        smallint check (cycle_day between 1 and 7),
  label            text,
  unique (academic_year_id, date)
);

-- ---------- Versioned timetable ----------------------------------------------
-- One import == one schedule_version with an effective range. Versions for the
-- same academic year may not overlap in time (enforced below).
create table schedule_versions (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years(id) on delete cascade,
  name             text not null,                 -- e.g. "v3 — adjusted times Aug 18"
  effective_from   date not null,
  effective_to     date,                          -- null = open-ended / current
  source_note      text,
  is_published     boolean not null default false,
  imported_at      timestamptz not null default now(),
  constraint no_overlap exclude using gist (
    academic_year_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
);

-- A recurring slot WITHIN a version, keyed to a ROTATION day (cycle_day 1..5),
-- not a weekday. start/end times live here so a new version can carry different
-- class times, and so per-cell time overrides from aSc are preserved. Room is
-- nullable & freely editable.
create table lessons (
  id                  uuid primary key default gen_random_uuid(),
  schedule_version_id uuid not null references schedule_versions(id) on delete cascade,
  teacher_id          uuid not null references teachers(id),
  subject_id          uuid not null references subjects(id),
  room_id             uuid references rooms(id),
  cycle_id            uuid not null references cycles(id),
  period_id           uuid references periods(id),     -- label/sort only
  cycle_day           smallint not null check (cycle_day between 1 and 7),  -- DAY 1..5
  start_time          time not null,
  end_time            time not null,
  asc_lesson_id       text,
  unique (schedule_version_id, teacher_id, cycle_day, start_time)
);

create index on lessons (schedule_version_id, teacher_id, cycle_day);

-- ---------- Concrete class instances (generated) -----------------------------
-- Snapshots the resolved timestamps so later time/version changes can't rewrite
-- the past. Subject/cycle/room are read live from the lesson via the view.
create table class_sessions (
  id              uuid primary key default gen_random_uuid(),
  lesson_id       uuid not null references lessons(id) on delete cascade,
  date            date not null,
  scheduled_start timestamptz not null,
  scheduled_end   timestamptz not null,
  state           session_state not null default 'pending',
  unique (lesson_id, date)
);

create index on class_sessions (date);
create index on class_sessions (scheduled_end);

-- ---------- Reporting --------------------------------------------------------
create table report_reasons (        -- pre-populated dropdown for "Missed"
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  sort_order int  not null default 0,
  is_active  boolean not null default true
);

create table class_reports (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null unique references class_sessions(id) on delete cascade,
  teacher_id   uuid not null references teachers(id),
  status       report_status not null,
  reason_id    uuid references report_reasons(id),     -- required when missed
  other_reason text,
  note         text,
  source       report_source not null default 'app',
  reported_at  timestamptz not null default now(),
  check (status = 'given' or reason_id is not null or other_reason is not null)
);

-- ---------- Web Push subscriptions -------------------------------------------
create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- =============================================================================
-- Helpers
-- =============================================================================
create or replace function current_teacher_id() returns uuid
language sql stable security definer as $$
  select id from teachers where email = (auth.jwt() ->> 'email')::citext;
$$;

create or replace function is_staff() returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from teachers
    where email = (auth.jwt() ->> 'email')::citext
      and role in ('coordinator', 'admin')
  );
$$;

-- Keep a session's state in sync when a report lands / is removed.
create or replace function sync_session_state() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    update class_sessions set state = 'pending' where id = old.session_id;
    return old;
  else
    update class_sessions set state = 'reported' where id = new.session_id;
    return new;
  end if;
end;
$$;
create trigger trg_sync_session_state
  after insert or delete on class_reports
  for each row execute function sync_session_state();

-- =============================================================================
-- Session generation
-- =============================================================================
-- For each class-day, materialize the lessons of the schedule_version that is
-- effective on that day. p_from lets you regenerate only forward in time.
create or replace function generate_sessions(p_year uuid, p_from date default null)
returns int language plpgsql as $$
declare n int;
begin
  insert into class_sessions (lesson_id, date, scheduled_start, scheduled_end)
  select l.id, d.date,
         (d.date + l.start_time) at time zone 'America/Bogota',
         (d.date + l.end_time)   at time zone 'America/Bogota'
  from calendar_days d
  join schedule_versions v on v.academic_year_id = d.academic_year_id
                          and v.is_published
                          and d.date >= v.effective_from
                          and d.date <= coalesce(v.effective_to, 'infinity'::date)
  join lessons l on l.schedule_version_id = v.id
                and l.cycle_day = d.cycle_day        -- rotation-day match, not weekday
  where d.academic_year_id = p_year
    and d.day_type = 'class'
    and d.cycle_day is not null
    and (p_from is null or d.date >= p_from)
  on conflict (lesson_id, date) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- THE key entry point for "update the schedule anytime":
--   1. import the new version's lessons (is_published = false),
--   2. call publish_timetable(new_version_id) -> closes the prior open version,
--      drops only future UN-REPORTED sessions, regenerates from effective_from.
-- Reported and past sessions are never touched.
create or replace function publish_timetable(p_version uuid)
returns int language plpgsql as $$
declare v_year uuid; v_from date;
begin
  select academic_year_id, effective_from into v_year, v_from
  from schedule_versions where id = p_version;

  -- close any other open-ended version of this year that starts earlier
  update schedule_versions
     set effective_to = v_from - 1
   where academic_year_id = v_year
     and id <> p_version
     and effective_to is null
     and effective_from < v_from;

  update schedule_versions set is_published = true where id = p_version;

  -- remove future sessions that have NOT been reported (safe to rebuild)
  delete from class_sessions s
   where s.date >= v_from
     and s.state = 'pending'
     and not exists (select 1 from class_reports r where r.session_id = s.id);

  return generate_sessions(v_year, v_from);
end;
$$;

-- =============================================================================
-- Dashboard view: powers the "most recently completed class" fast UI.
-- Reads room/subject/cycle live from the lesson, so a room edit shows instantly.
-- =============================================================================
create or replace view v_session_cards
with (security_invoker = true) as   -- enforce the CALLER's RLS, not the view owner's
select s.id            as session_id,
       s.date, s.scheduled_start, s.scheduled_end, s.state,
       l.teacher_id,
       t.full_name     as teacher_name,
       sub.name        as subject_name,
       c.name          as cycle_name,
       r.name          as room_name,
       p.name          as period_name,
       cr.id           as report_id,
       cr.status       as report_status
from class_sessions s
join lessons   l   on l.id = s.lesson_id
join teachers  t   on t.id = l.teacher_id
join subjects  sub on sub.id = l.subject_id
join cycles    c   on c.id = l.cycle_id
left join periods p on p.id = l.period_id
left join rooms r  on r.id = l.room_id
left join class_reports cr on cr.session_id = s.id;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table teachers           enable row level security;
alter table class_sessions     enable row level security;
alter table class_reports      enable row level security;
alter table push_subscriptions enable row level security;
alter table lessons            enable row level security;
alter table report_reasons     enable row level security;

create policy teachers_self_read on teachers for select
  using (id = current_teacher_id() or is_staff());

create policy lessons_read on lessons for select
  using (teacher_id = current_teacher_id() or is_staff());

create policy sessions_read on class_sessions for select
  using (exists (select 1 from lessons l where l.id = lesson_id
                 and (l.teacher_id = current_teacher_id() or is_staff())));

create policy reports_read on class_reports for select
  using (teacher_id = current_teacher_id() or is_staff());
create policy reports_insert on class_reports for insert
  with check (teacher_id = current_teacher_id());
create policy reports_update on class_reports for update
  using (teacher_id = current_teacher_id() or is_staff());

create policy push_self on push_subscriptions for all
  using (teacher_id = current_teacher_id())
  with check (teacher_id = current_teacher_id());

create policy reasons_read on report_reasons for select
  using (auth.role() = 'authenticated');

-- ---------- Seed: standard administrative reasons ----------------------------
insert into report_reasons (label, sort_order) values
  ('Asamblea / Evento institucional', 1),
  ('Problema técnico', 2),
  ('Salida pedagógica', 3),
  ('Reunión convocada', 4),
  ('Incapacidad / Ausencia docente', 5),
  ('Otro', 99);

-- =============================================================================
-- Admin compliance: extend the card view with reason/report detail, and add a
-- per-day compliance rollup. Both run with the caller's RLS (staff see all).
-- =============================================================================

-- create-or-replace can only APPEND columns, so the new fields go at the end.
create or replace view v_session_cards
with (security_invoker = true) as
select s.id            as session_id,
       s.date, s.scheduled_start, s.scheduled_end, s.state,
       l.teacher_id,
       t.full_name     as teacher_name,
       sub.name        as subject_name,
       c.name          as cycle_name,
       r.name          as room_name,
       p.name          as period_name,
       cr.id           as report_id,
       cr.status       as report_status,
       cr.reason_id    as reason_id,
       rr.label        as reason_label,
       cr.other_reason as other_reason,
       cr.reported_at  as reported_at
from class_sessions s
join lessons   l   on l.id = s.lesson_id
join teachers  t   on t.id = l.teacher_id
join subjects  sub on sub.id = l.subject_id
join cycles    c   on c.id = l.cycle_id
left join periods p on p.id = l.period_id
left join rooms r  on r.id = l.room_id
left join class_reports cr on cr.session_id = s.id
left join report_reasons rr on rr.id = cr.reason_id;

-- Daily rollup for the compliance dashboard.
create or replace view v_daily_compliance
with (security_invoker = true) as
select s.date,
       count(*)                                          as total,
       count(cr.id)                                      as reported,
       count(*) filter (where cr.status = 'given')       as given,
       count(*) filter (where cr.status = 'missed')      as missed,
       count(*) filter (where cr.id is null
                          and s.scheduled_end <= now())  as pending,
       round(100.0 * count(cr.id) / nullif(count(*), 0), 1) as reported_pct
from class_sessions s
left join class_reports cr on cr.session_id = s.id
group by s.date;

-- Stream report writes to the admin board (RLS still applies per subscriber).
alter publication supabase_realtime add table class_reports;

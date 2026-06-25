# Data import pipeline

The teacher schedule changes several times a year (rooms, and at the start of the
year also class **times**). Imports are therefore idempotent and **versioned**:
each schedule import is a `schedule_version` with an `effective_from` date.
Reported/past sessions are never touched — only future un-reported sessions are
rebuilt.

## 0. Prereqs

`.env.local` must contain `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. The migration in `supabase/migrations/0001_init.sql`
must be applied (`npx supabase db reset` locally).

Create the academic year once and copy its id:

```sql
insert into academic_years (name, start_date, end_date)
values ('2026-2027', '2026-08-03', '2027-06-30') returning id;
```

## 1. Calendar (once per year, re-runnable)

Parses the visual month-per-sheet xlsx. Each date cell is paired with the
annotation cell below it; `DAY n` → `cycle_day`, breaks → `holiday`.

```bash
npm run import:calendar -- "source_data/School Calendar 2026-2027.xlsx" <year_id>
```

> Review `calendar_days.day_type`/`cycle_day` afterward — the visual sheet is
> human-formatted, so a few event/holiday cells may need a manual fix before
> sessions are generated.

## 2. Schedule (re-run whenever it changes)

Input is a normalized CSV (export from aSc Horarios → map to these columns).
This stable contract avoids scraping the brittle aSc PDF:

```
teacher_email,teacher_name,subject_code,subject_name,cycle_code,cycle_name,room_code,room_name,period_name,period_order,cycle_day,start_time,end_time
```

- `cycle_day` = rotation day 1..5 (the `DAY n` columns), **not** a weekday
- `start_time`/`end_time` = `HH:MM` 24h, per row (per-cell overrides preserved)

```bash
npm run import:schedule -- schedule.csv <year_id> 2026-08-03 "v1 — start of year"
# mid-year change:
npm run import:schedule -- schedule.csv <year_id> 2026-09-15 "v2 — times adjusted"
```

The script creates the version, upserts dimensions, inserts lessons, then calls
`publish_timetable()` which closes the prior version and regenerates future
sessions.

### Getting the CSV from aSc

Prefer **aSc Horarios → Export → CSV/XML** over the PDF. If only the PDF exists,
extract word coordinates (`pdftotext -bbox`) and bucket words into the DAY-column
× period-row grid; the per-teacher pages map directly onto the CSV columns above.

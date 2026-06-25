# Class Tracker — Handoff

PWA for school faculty to log class execution. Top priority: a **frictionless,
sub-5-second** reporting experience for teachers.

## Stack

- **Next.js 16** (App Router, TypeScript, `src/`) as a PWA — Turbopack build
- **Tailwind v4**
- **Supabase** — Postgres + Auth (Google Workspace OAuth) + RLS + Realtime + (planned) Edge Functions + pg_cron
- **@supabase/ssr** for cookie-based auth in Server Components / proxy
- Import scripts run with **tsx**

## Repo layout

```
supabase/migrations/0001_init.sql   # full schema, RLS, views, session-gen functions
scripts/                            # data import pipeline (see scripts/README.md)
  import-calendar.ts                #   xlsx month-grid -> calendar_days  (VALIDATED on real file)
  import-schedule.ts                #   normalized CSV -> versioned timetable, then publish
  lib/db.ts                         #   service-role client + dimension upserts
src/
  app/page.tsx                      # fast dashboard: most-recently-completed class card
  app/actions.ts                    # submitReport server action (RLS-safe upsert)
  app/login/, app/auth/callback/    # Google OAuth flow
  components/report-card.tsx        # one-tap Given / Missed + reason dropdown
  lib/queries.ts                    # getDashboardCard / getPendingToday / getReasons
  lib/supabase/{server,client}.ts   # SSR + browser clients
  proxy.ts                          # session refresh (Next 16 renamed "middleware" -> "proxy")
source_data/                        # raw exports (binaries git-ignored)
```

## Key design decisions (read before changing the schema)

1. **Rotating day cycle, not weekdays.** This school runs a `DAY 1..DAY 5`
   rotation that skips holidays. `calendar_days.cycle_day` maps each physical
   date to its rotation day; `lessons.cycle_day` keys the timetable. Session
   generation joins on `cycle_day`, **never** on weekday.

2. **Versioned timetables.** The schedule changes several times a year (rooms,
   and at year start also class *times*). Each import is a `schedule_version`
   with an `effective_from` (non-overlapping ranges per year, DB-enforced).
   `publish_timetable(version_id)` closes the prior version, deletes only future
   **un-reported** sessions, and regenerates from `effective_from`. Past and
   reported sessions are never touched. Room changes are cheap — edit the lesson;
   the dashboard view reads room/subject/cycle live.

3. **`class_sessions` snapshots timestamps** (`scheduled_start/end`) so later
   time/version changes can't rewrite history. Existence of a session with no
   `class_reports` row == a missing report (trivial compliance query).

4. **RLS everywhere.** `current_teacher_id()` / `is_staff()` resolve the Google
   email to the `teachers` row. Teachers see only their own data; coordinators/
   admins see all. The dashboard view uses `security_invoker = true` so the
   caller's RLS actually applies through it.

## First-time setup on a new machine

```bash
git clone https://github.com/WorkWebsitesMixed/class_tracker.git
cd class_tracker
npm install
cp .env.example .env.local      # fill in Supabase + Google + VAPID values

# local DB (Docker required)
npx supabase init               # only if supabase/config.toml is absent
npx supabase start
npx supabase db reset           # applies 0001_init.sql

npm run dev
```

Copy the raw exports into `source_data/` (they're git-ignored — grab from Drive).

## Data import (re-runnable)

```sql
insert into academic_years (name, start_date, end_date)
values ('2026-2027','2026-08-03','2027-06-30') returning id;
```

```bash
npm run import:calendar -- "source_data/School Calendar 2026-2027.xlsx" <year_id>
npm run import:schedule -- source_data/schedule.csv <year_id> 2026-08-03 "v1 — start of year"
```

CSV column contract and the aSc export notes live in `scripts/README.md`.

## Status

**Done**
- Schema + RLS + session generation + versioning
- Calendar importer (validated against the real xlsx)
- Schedule importer (CSV -> versioned timetable -> publish)
- Fast teacher dashboard: context-aware card, one-tap Given/Missed, reason
  dropdown + free-text, pending-today list, `?session=` deep links
- Google OAuth (login / callback / session-refresh proxy)
- Production build is clean

- Notifications: end-of-block Web Push + Google Chat fallback, deep-linking to
  `/?session=<id>` (see "Notifications" below)
- Admin compliance panel at `/admin` — staff-gated (`requireStaff()`), daily
  summary cards, filter by status/teacher/reason, CSV export, live-refresh via
  Realtime on `class_reports`. Schema: `0003_admin.sql` (extends the card view +
  `v_daily_compliance`). Teacher dashboard shows an "Admin" link to staff.

**Not started (schema already supports these)**
- PWA manifest + service worker for installability/offline shell (note: `sw.js`
  already exists for push; a manifest + icons are still needed to install)
- aSc PDF -> CSV converter (currently the CSV is produced from aSc export)

## Notifications (pg_cron -> Edge Function -> Web Push / Chat)

Flow: `pg_cron` runs `trigger_block_end_notify()` every 5 min -> `pg_net` POSTs
the `notify-block-end` Edge Function -> it reads `sessions_to_notify()` (ended,
unreported, not yet notified), sends Web Push to each device in
`push_subscriptions`, optionally posts the Google Chat webhook, and stamps
`class_sessions.notified_at`. The teacher taps the notification -> `/?session=<id>`
opens the exact card. Migration: `0002_notifications.sql`.

One-time setup:
```bash
npx web-push generate-vapid-keys              # -> .env.local NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_*
supabase functions deploy notify-block-end
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:admin@school.edu.co APP_URL=https://<app-domain> \
  GOOGLE_CHAT_WEBHOOK_URL=...                  # webhook optional
```
Then, in the Supabase SQL editor, store the cron's secrets so it stops being a
no-op:
```sql
select vault.create_secret('https://<ref>.functions.supabase.co/notify-block-end','notify_edge_url');
select vault.create_secret('<service_role_key>','notify_service_key');
```
Client: `src/components/push-manager.tsx` registers `public/sw.js`, asks
permission, and saves the subscription via the `savePushSubscription` action.
Requires HTTPS (works on localhost for testing).

## Gotchas

- `gh` CLI is not installed locally; use plain `git` over HTTPS.
- Next 16 uses `src/proxy.ts` (not `middleware.ts`).
- `xlsx` is CJS; scripts import it as `import * as XLSX` (works under tsx).
- Build needs no secrets, but runtime/auth does — set `.env.local`.

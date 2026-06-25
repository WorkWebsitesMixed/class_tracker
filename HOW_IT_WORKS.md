# How Class Tracker works

A conceptual tour of the system — the *why* and the *flow*, not the setup
(that's `HANDOFF.md`) or the import mechanics (that's `scripts/README.md`).
Read this first.

---

## 1. The problem it solves

Coordination needs to know, every day, **which classes actually happened** and
**why the others didn't**. The only way that data stays honest is if reporting
it costs the teacher almost nothing. So the whole design bends toward one number:
**the time from opening the app to a logged class should be under 5 seconds.**

Everything else — the schema, the notifications, the admin views — exists to feed
or protect that one fast interaction.

---

## 2. Who touches the system

| Actor | What they do |
|-------|--------------|
| **Teacher** | Opens the app, taps "Dictada" / "No dictada" on the class that just ended. That's it. |
| **Coordinator / Admin** | Watches the live compliance board, filters, exports reports. Never edits a teacher's reality, only reads it. |
| **The system** (cron + edge function) | At the end of each block, nudges teachers who haven't reported, with a link straight to the right card. |

Roles live on the `teachers.role` column (`teacher` / `coordinator` / `admin`).

---

## 3. Two ideas that shape everything

### a) It's a rotating day cycle, not a weekly calendar

This school doesn't run "Monday's schedule, Tuesday's schedule." It runs a
**DAY 1 → DAY 5 rotation that skips holidays**. If Wednesday is a holiday, the
"DAY 3" that would've been Wednesday simply happens on the next school day.

So we never ask *"what's the schedule for Tuesday?"*. We ask:

```
physical date  ──>  which rotation day is it?  ──>  what lessons run on that rotation day?
   (calendar)            (calendar_days.cycle_day)        (lessons.cycle_day)
```

- The **master calendar** (`calendar_days`) is the source of truth that maps each
  real date to its `cycle_day` (1–5), or marks it holiday/event (no cycle_day).
- The **timetable** (`lessons`) is defined *per rotation day*, not per weekday.

This is why the calendar importer reads "DAY n" out of the spreadsheet, and why
session generation joins `calendar_days.cycle_day = lessons.cycle_day`.

### b) Timetables are versioned

The schedule changes several times a year — rooms shuffle constantly, and at the
start of the year even the **class times** move. We must never let a schedule
change rewrite what already happened.

So every import is a **`schedule_version`** with an `effective_from` date:

```
v1  ●───────────────●   (Aug–Sep, original times)
v2                  ●─────────────────▶  (from Sep 15, adjusted times)
                    ↑ effective_from
```

When you publish a new version, `publish_timetable()`:
1. closes the previous version (`effective_to = new start − 1`),
2. deletes only **future, un-reported** sessions,
3. regenerates future sessions from the new version.

Anything already reported, or in the past, is frozen. (Room changes are the cheap
exception — you can just edit the lesson; the dashboard reads the room live.)

---

## 4. From spreadsheet to a tappable card

```
aSc schedule (CSV)  ──import:schedule──>  schedule_version + lessons
school calendar (xlsx) ──import:calendar──> calendar_days (date → cycle_day)
                                   │
                                   ▼
                    generate_sessions() / publish_timetable()
                                   │
                                   ▼
                            class_sessions
        (one concrete row per lesson per real date, with frozen
         scheduled_start / scheduled_end timestamps)
                                   │
                          teacher taps a button
                                   ▼
                             class_reports
                   (given | missed + reason; one per session)
```

**Key insight:** a `class_session` with **no** matching `class_reports` row *is*
a missing report. That makes "who hasn't reported?" a trivial query instead of a
calculation — and it's what powers both the notifications and the admin board.

`class_sessions` snapshots the start/end **timestamps** at generation time, so a
later time change or new version can never alter the meaning of a past class.

---

## 5. The teacher's 5 seconds

1. They open the PWA (already logged in via Google).
2. The home page asks one question: *"what's the most recently finished class
   today for this teacher that they could report?"* — one indexed query against
   `v_session_cards` filtered to `date = today`, `scheduled_end <= now`, newest
   first. (`src/lib/queries.ts → getDashboardCard`)
3. That class is shown as a big card with two buttons.
   - **Dictada** → one tap, done.
   - **No dictada** → reveals the pre-set reason buttons (Asamblea, Problema
     técnico, …) + an "Otro" free-text. One more tap, done.
4. The tap calls the `submitReport` server action, which writes a `class_reports`
   row (upsert, so a mistap is correctable).

Below the card, a short "Pendientes hoy" list lets them mop up anything they
missed. A notification deep-link (`/?session=<id>`) jumps straight to a specific
card.

---

## 6. The nudge (notifications)

The system reminds teachers who let a block end without reporting:

```
pg_cron (every 5 min)
   └─> trigger_block_end_notify()         [Postgres]
         └─> pg_net HTTP POST
               └─> notify-block-end        [Supabase Edge Function]
                     ├─ sessions_to_notify(): ended, unreported, not yet notified
                     ├─ Web Push to each of the teacher's devices
                     ├─ Google Chat webhook (optional fallback)
                     └─ stamp class_sessions.notified_at  (so it never repeats)
```

The push notification carries the deep link. Tapping it opens the exact card —
closing the loop back to section 5. The cron is **TZ-safe and idempotent**: it
runs all day but only acts on classes that genuinely just ended and haven't been
notified.

---

## 7. The coordinator's view (`/admin`)

- Gated by role (`requireStaff()` — non-staff get redirected away).
- **Summary cards**: total / given / missed / unreported / compliance %, from the
  `v_daily_compliance` rollup.
- **Filters** (date, status, teacher, reason) live in the URL, so a filtered view
  is a shareable link.
- **CSV export** dumps exactly the filtered rows for offline analysis.
- **Live**: it subscribes to `class_reports` changes over Supabase Realtime, so
  the board updates itself as teachers report during the day.

---

## 8. Why nobody sees anyone else's data

Two layers:

1. **Google Workspace OAuth** logs the teacher in; the app links their email to a
   `teachers` row (`current_teacher_id()`).
2. **Row Level Security** in Postgres does the actual enforcement: a teacher's
   queries can only return their own sessions/reports; staff (`is_staff()`) can
   read all. This is enforced in the database, not the app — even the dashboard
   *view* runs with `security_invoker = true` so the caller's RLS still applies.

So the security doesn't depend on the UI remembering to filter; it's structural.

---

## 9. Where to look in the code

| You want to understand… | Start here |
|--------------------------|-----------|
| The whole data model + rules | `supabase/migrations/0001_init.sql` |
| Versioning / session generation | `publish_timetable()`, `generate_sessions()` in `0001` |
| Notifications | `0002_notifications.sql` + `supabase/functions/notify-block-end/` |
| Admin views | `0003_admin.sql` |
| The fast teacher flow | `src/app/page.tsx`, `src/components/report-card.tsx`, `src/app/actions.ts` |
| Reads/queries | `src/lib/queries.ts`, `src/lib/admin-queries.ts` |
| Auth plumbing | `src/lib/supabase/*`, `src/proxy.ts`, `src/app/auth/callback/` |
| Importing data | `scripts/` (+ `scripts/README.md`) |

---

## 10. The shortest possible summary

> A versioned, rotation-aware timetable is exploded into one concrete row per
> class per day. A class with no report attached is, by definition, unreported —
> which makes nudging teachers and reporting compliance both trivial. The teacher
> UI does exactly one thing fast; everything else reads from the same simple fact.

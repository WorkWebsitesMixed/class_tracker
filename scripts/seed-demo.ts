/**
 * Seeds two weeks of backdated class sessions for demo teachers,
 * with realistic report data (given / missed / unreported).
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts [--clear]
 *
 * --clear  deletes existing demo sessions before re-seeding
 */

import { admin } from "./lib/db";

const DEMO_EMAILS = [
  "andres.forero@marymount.edu.co",
  "felipe.velasquez@marymount.edu.co",
];

// June 9–24 2026 weekdays → rotating cycle day 1..5
const SCHOOL_DAYS: { date: string; cycleDay: number }[] = [
  { date: "2026-06-09", cycleDay: 1 },
  { date: "2026-06-10", cycleDay: 2 },
  { date: "2026-06-11", cycleDay: 3 },
  { date: "2026-06-12", cycleDay: 4 },
  { date: "2026-06-15", cycleDay: 5 },
  { date: "2026-06-16", cycleDay: 1 },
  { date: "2026-06-17", cycleDay: 2 },
  { date: "2026-06-18", cycleDay: 3 },
  { date: "2026-06-19", cycleDay: 4 },
  { date: "2026-06-22", cycleDay: 5 },
  { date: "2026-06-23", cycleDay: 1 },
  { date: "2026-06-24", cycleDay: 2 },
];

// Missed-class reason IDs from report_reasons table
const MISSED_REASONS = [
  "08f418ab-122a-4eba-9213-04072e608ccb", // Asamblea / Evento institucional
  "45f57cda-e327-4cdb-92fc-29438e8e375e", // Reunión convocada
  "97f8fcbf-732e-4738-b1af-3fe9877421cf", // Incapacidad / Ausencia docente
];

// Deterministic "random" so re-runs produce the same data
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function pick<T>(arr: T[], seed: string): T {
  return arr[hash(seed) % arr.length];
}

// week 1 (June 9-12, 15): all reported
// week 2 (June 16-24): 65% reported, rest unreported
function shouldReport(date: string, sessionKey: string): boolean {
  if (date <= "2026-06-15") return true;
  return hash(sessionKey) % 100 < 65;
}

// 85% given, 15% missed among reported sessions
function reportStatus(sessionKey: string): "given" | "missed" {
  return hash(sessionKey + "status") % 100 < 85 ? "given" : "missed";
}

async function main() {
  const doClear = process.argv.includes("--clear");

  // Resolve teacher IDs
  const teacherIds: Record<string, string> = {};
  for (const email of DEMO_EMAILS) {
    const { data } = await admin.from("teachers").select("id").eq("email", email).single();
    if (!data) { console.error(`Teacher not found: ${email}`); process.exit(1); }
    teacherIds[email] = data.id;
  }

  if (doClear) {
    const ids = Object.values(teacherIds);
    const { data: sessions } = await admin
      .from("class_sessions")
      .select("id, lesson_id, lessons!inner(teacher_id)")
      .in("lessons.teacher_id", ids)
      .gte("date", "2026-06-09")
      .lte("date", "2026-06-24");
    if (sessions?.length) {
      await admin.from("class_sessions").delete().in("id", sessions.map((s) => s.id));
      console.log(`Cleared ${sessions.length} existing demo sessions.`);
    }
  }

  // Fetch lessons for both teachers
  const { data: lessons } = await admin
    .from("lessons")
    .select("id, teacher_id, cycle_day, start_time, end_time")
    .in("teacher_id", Object.values(teacherIds));
  if (!lessons) throw new Error("No lessons found");

  // Build sessions
  const sessionRows: object[] = [];
  for (const day of SCHOOL_DAYS) {
    const dayLessons = lessons.filter((l) => l.cycle_day === day.cycleDay);
    for (const lesson of dayLessons) {
      const start = `${day.date}T${lesson.start_time.slice(0, 5)}:00-05:00`; // COT = UTC-5
      const end   = `${day.date}T${lesson.end_time.slice(0, 5)}:00-05:00`;
      sessionRows.push({
        lesson_id: lesson.id,
        date: day.date,
        scheduled_start: start,
        scheduled_end: end,
      });
    }
  }

  const { data: inserted, error: sErr } = await admin
    .from("class_sessions")
    .upsert(sessionRows, { onConflict: "lesson_id,date" })
    .select("id, lesson_id, date");
  if (sErr) throw sErr;
  console.log(`✓ Upserted ${inserted.length} sessions`);

  // Build reports for sessions that should be reported
  // We need teacher_id for each session (via lesson)
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));
  const reportRows: object[] = [];

  for (const session of inserted) {
    const lesson = lessonMap.get(session.lesson_id);
    if (!lesson) continue;
    const key = `${session.lesson_id}:${session.date}`;
    if (!shouldReport(session.date, key)) continue;

    const status = reportStatus(key);
    const row: Record<string, unknown> = {
      session_id: session.id,
      teacher_id: lesson.teacher_id,
      status,
      source: "app",
      reported_at: `${session.date}T${lesson.end_time.slice(0, 5)}:30-05:00`,
    };
    if (status === "missed") {
      row.reason_id = pick(MISSED_REASONS, key);
    }
    reportRows.push(row);
  }

  const { error: rErr } = await admin
    .from("class_reports")
    .upsert(reportRows, { onConflict: "session_id" });
  if (rErr) throw rErr;

  const given  = reportRows.filter((r: any) => r.status === "given").length;
  const missed = reportRows.filter((r: any) => r.status === "missed").length;
  const pending = inserted.length - reportRows.length;
  console.log(`✓ ${given} given, ${missed} missed, ${pending} pending (unreported)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

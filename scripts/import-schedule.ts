/**
 * Import a teacher timetable as a NEW versioned schedule, then publish it.
 *
 * Input is a normalized CSV — a stable contract that survives the frequent
 * schedule changes and decouples us from the brittle aSc PDF layout. aSc
 * Horarios can export CSV/XML directly; map its export to these columns:
 *
 *   teacher_email,teacher_name,subject_code,subject_name,cycle_code,cycle_name,
 *   room_code,room_name,period_name,period_order,cycle_day,start_time,end_time
 *
 *   - cycle_day  = rotation day 1..5 (the "DAY n" columns), NOT a weekday
 *   - start_time/end_time = "HH:MM" 24h (per-cell, so overrides are preserved)
 *   - room_code/room_name may be blank
 *
 * Usage:
 *   npx tsx scripts/import-schedule.ts <file.csv> <academic_year_id> <effective_from YYYY-MM-DD> "<version name>"
 *
 * Re-run anytime the schedule changes (new effective_from). Past/reported
 * sessions are preserved; only future un-reported sessions are rebuilt.
 */
import { readFileSync } from "node:fs";
import { admin, upsertByCode } from "./lib/db";

/** Minimal RFC-4180-ish CSV parser (handles quoted fields & commas). */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift()!.map((h) => h.trim());
  return rows
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

async function getTeacherId(email: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from("teachers")
    .upsert({ email, full_name: name }, { onConflict: "email" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function getPeriodId(name: string, order: number): Promise<string> {
  const { data, error } = await admin
    .from("periods")
    .upsert({ name, sort_order: order }, { onConflict: "sort_order" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function main() {
  const [file, yearId, effFrom, versionName] = process.argv.slice(2);
  if (!file || !yearId || !effFrom || !versionName) {
    console.error(
      'Usage: tsx scripts/import-schedule.ts <file.csv> <academic_year_id> <effective_from> "<version name>"',
    );
    process.exit(1);
  }

  const records = parseCSV(readFileSync(file, "utf8"));
  console.log(`Read ${records.length} lesson rows.`);

  // 1. Create the (unpublished) version.
  const { data: version, error: vErr } = await admin
    .from("schedule_versions")
    .insert({
      academic_year_id: yearId,
      name: versionName,
      effective_from: effFrom,
      is_published: false,
    })
    .select("id")
    .single();
  if (vErr) throw vErr;

  // 2. Resolve dimensions (cached to cut round-trips) and build lesson rows.
  const cache = new Map<string, string>();
  const memo = async (key: string, fn: () => Promise<string>) => {
    if (!cache.has(key)) cache.set(key, await fn());
    return cache.get(key)!;
  };

  const lessons = [];
  for (const r of records) {
    const teacherId = await memo(`t:${r.teacher_email}`, () =>
      getTeacherId(r.teacher_email.toLowerCase(), r.teacher_name),
    );
    const subjectId = await memo(`s:${r.subject_code}`, () =>
      upsertByCode("subjects", r.subject_code, r.subject_name),
    );
    const cycleId = await memo(`c:${r.cycle_code}`, () =>
      upsertByCode("cycles", r.cycle_code, r.cycle_name),
    );
    const roomId = r.room_code
      ? await memo(`r:${r.room_code}`, () =>
          upsertByCode("rooms", r.room_code, r.room_name || r.room_code),
        )
      : null;
    const periodId = await memo(`p:${r.period_order}`, () =>
      getPeriodId(r.period_name || r.period_order, Number(r.period_order)),
    );

    lessons.push({
      schedule_version_id: version.id,
      teacher_id: teacherId,
      subject_id: subjectId,
      cycle_id: cycleId,
      room_id: roomId,
      period_id: periodId,
      cycle_day: Number(r.cycle_day),
      start_time: r.start_time,
      end_time: r.end_time,
    });
  }

  const { error: lErr } = await admin.from("lessons").insert(lessons);
  if (lErr) throw lErr;
  console.log(`Inserted ${lessons.length} lessons into version ${version.id}.`);

  // 3. Publish: closes prior version, rebuilds only future un-reported sessions.
  const { data: count, error: pErr } = await admin.rpc("publish_timetable", {
    p_version: version.id,
  });
  if (pErr) throw pErr;
  console.log(`Published. Generated ${count} future class sessions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

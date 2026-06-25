/**
 * Converts the aSc per-teacher xlsx (one sheet per teacher) into the normalized
 * CSV expected by import-schedule.ts.
 *
 * Also writes a teacher-emails-generated.csv alongside so you can verify/correct
 * the auto-generated emails before running the actual import.
 *
 * Usage:
 *   npx tsx scripts/convert-schedule-xlsx.ts <xlsx> [out.csv] [emails.csv]
 *
 * Defaults:
 *   out.csv   → schedule-converted.csv
 *   emails.csv → teacher-emails-generated.csv
 *
 * Workflow:
 *   1. Run this script → review teacher-emails-generated.csv
 *   2. Copy the generated CSV, fill in the "correct_email" column
 *   3. Re-run with --email-map=<corrected.csv> to produce the final schedule CSV
 *      (or edit the teacher rows directly in Supabase after import)
 */

import * as XLSX from "xlsx";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const xlsxPath = args.find((a) => !a.startsWith("--"));
const emailMapArg = args.find((a) => a.startsWith("--email-map="))?.split("=")[1];
const outCsv = args.find((a) => a.endsWith(".csv") && !a.startsWith("--") && a !== xlsxPath)
  ?? "schedule-converted.csv";
const outEmails = "teacher-emails-generated.csv";

if (!xlsxPath) {
  console.error("Usage: npx tsx scripts/convert-schedule-xlsx.ts <xlsx> [out.csv] [--email-map=corrected.csv]");
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function removeAccents(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function nameToEmail(fullName: string): string {
  const words = removeAccents(fullName.trim().toLowerCase()).split(/\s+/);
  const first = words[0];
  // For 4-word names: word[0] + word[2] (first name + first surname)
  // For 3-word names: word[0] + word[1] (first name + first surname)
  // For 2-word names: word[0] + word[1]
  const last = words.length >= 4 ? words[2] : words[words.length - 1];
  return `${first}.${last}@marymount.edu.co`;
}

function parseTime(s: string): [string, string] | null {
  const clean = s.replace(/\s/g, "");
  const m = clean.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return null;
  const pad = (t: string) => t.length === 4 ? `0${t}` : t;
  return [pad(m[1]), pad(m[2])];
}

const SKIP_SUBJECTS = /^(planning|reun?i?[oó]?n?|ac$|\.|descanso|almuerzo|cafeter[ií]a|parque)/i;
const SKIP_CYCLES   = /^[.\s]*$/;

function isRealClass(subject: string, cycle: string): boolean {
  if (!subject.trim() || !cycle.trim()) return false;
  if (SKIP_SUBJECTS.test(subject.trim())) return false;
  if (SKIP_CYCLES.test(cycle.trim())) return false;
  return true;
}

function toCsvLine(fields: string[]): string {
  return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",");
}

// ── load optional email map ───────────────────────────────────────────────────

const emailMap = new Map<string, string>(); // fullName (upper) → correct email
if (emailMapArg && existsSync(emailMapArg)) {
  const lines = readFileSync(emailMapArg, "utf8").split(/\r?\n/).slice(1);
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols[0] && cols[2]) emailMap.set(cols[0].toUpperCase(), cols[2]);
  }
  console.log(`Loaded ${emailMap.size} email overrides from ${emailMapArg}`);
}

// ── parse xlsx ────────────────────────────────────────────────────────────────

const wb = XLSX.readFile(xlsxPath);

const csvLines: string[] = [
  toCsvLine([
    "teacher_email","teacher_name","subject_code","subject_name",
    "cycle_code","cycle_name","room_code","room_name",
    "period_name","period_order","cycle_day","start_time","end_time",
  ]),
];
const emailLines: string[] = [toCsvLine(["teacher_name","generated_email","correct_email"])];

let totalSlots = 0;

for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });

  // Row 0: full (untruncated) teacher name
  const teacherFullName = String(rows[0]?.[0] ?? "").trim().toUpperCase();
  if (!teacherFullName) continue;

  const generatedEmail = nameToEmail(teacherFullName);
  const teacherEmail = emailMap.get(teacherFullName) ?? generatedEmail;
  emailLines.push(toCsvLine([teacherFullName, generatedEmail, emailMap.get(teacherFullName) ?? ""]));

  const seen = new Set<string>(); // dedup key: teacher|cycle_day|start_time

  // Find period header rows: col[0] is "1".."15" AND col[1] contains a time
  const periodIdxs: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const c0 = String(rows[i][0]).trim();
    const c1 = String(rows[i][1]).trim();
    if (/^\d{1,2}$/.test(c0) && c1.includes(":")) periodIdxs.push(i);
  }

  for (let pi = 0; pi < periodIdxs.length; pi++) {
    const hi = periodIdxs[pi];
    const ni = pi + 1 < periodIdxs.length ? periodIdxs[pi + 1] : rows.length;

    const header = rows[hi];
    const periodOrder = parseInt(String(header[0]).trim(), 10);
    const periodName = `Período ${periodOrder}`;
    const defaultTimeStr = String(header[1]).trim();

    // Per-day times in cols 2–6 (DAY 1..5); fall back to default if blank
    const dayTimes: (string | null)[] = Array.from({ length: 5 }, (_, d) => {
      const t = String(header[2 + d] ?? "").trim();
      return t.includes(":") ? t : null;
    });

    // Collect non-empty content rows between this header and the next
    const contentRows = rows
      .slice(hi + 1, ni)
      .filter((r) => r.slice(2, 7).some((c) => String(c).trim() !== ""));

    if (contentRows.length < 2) continue; // pure break, nothing to emit

    // Layout: room | subject | cycle  (3-row blocks)
    // When only 2 rows present, treat as subject | cycle (no room info)
    const [roomRow, subjectRow, cycleRow] =
      contentRows.length >= 3
        ? [contentRows[0], contentRows[1], contentRows[2]]
        : [Array(7).fill(""), contentRows[0], contentRows[1]];

    for (let d = 0; d < 5; d++) {
      const col = 2 + d;
      const subjectCode = String(subjectRow[col] ?? "").trim();
      const cycleCode   = String(cycleRow[col] ?? "").trim();
      const roomRaw     = String(roomRow[col] ?? "").trim();

      if (!isRealClass(subjectCode, cycleCode)) continue;

      const timeStr = dayTimes[d] ?? defaultTimeStr;
      const parsed = parseTime(timeStr);
      if (!parsed) continue;

      // Deduplicate: the xlsx sometimes gives two periods the same start time on
      // the same day (data-entry error). The DB unique constraint would reject the
      // second one, so we skip it here and keep the first seen.
      const dedupKey = `${teacherEmail}|${d + 1}|${parsed[0]}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      csvLines.push(toCsvLine([
        teacherEmail,
        teacherFullName,
        subjectCode,
        subjectCode,     // subject_name = code; update once you have full names
        cycleCode,
        cycleCode,
        roomRaw,
        roomRaw,
        periodName,
        String(periodOrder),
        String(d + 1),   // cycle_day 1..5
        parsed[0],
        parsed[1],
      ]));
      totalSlots++;
    }
  }
}

writeFileSync(outCsv, csvLines.join("\n"));
writeFileSync(outEmails, emailLines.join("\n"));

console.log(`✓ ${totalSlots} class slots  →  ${outCsv}`);
console.log(`✓ ${emailLines.length - 1} teachers     →  ${outEmails}`);
console.log();
console.log("Next steps:");
console.log(`  1. Review ${outEmails} — fill in the 'correct_email' column`);
console.log(`  2. Re-run with: npx tsx scripts/convert-schedule-xlsx.ts ${xlsxPath} ${outCsv} --email-map=${outEmails}`);
console.log(`  3. Then: npm run import:schedule -- ${outCsv} <year_id> <YYYY-MM-DD> "v1 — start of year"`);

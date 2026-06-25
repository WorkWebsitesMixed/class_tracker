/**
 * Import the master academic calendar from the aSc/visual xlsx into calendar_days.
 *
 * Layout (per month sheet, one sheet per month):
 *   row with weekday headers (domingo..sábado) in cols B..H,
 *   then for each week: a row of Excel date serials, immediately followed by an
 *   annotation row whose cells carry "DAY n" + event text.
 * We pair every date cell with the annotation cell directly below it.
 *
 * Usage:
 *   npx tsx scripts/import-calendar.ts "source_data/School Calendar 2026-2027.xlsx" <academic_year_id>
 */
import * as XLSX from "xlsx";
import { admin } from "./lib/db";

const BREAK_RE = /break|navidad|vacacion|holy week|festivo|receso/i;
const DAY_RE = /DAY\s*(\d)/i;

type Row = {
  academic_year_id: string;
  date: string; // YYYY-MM-DD
  day_type: "class" | "holiday" | "event" | "weekend";
  cycle_day: number | null;
  label: string | null;
};

function excelSerialToISO(serial: number): string {
  // Excel 1900 date system (epoch 1899-12-30), UTC to avoid TZ drift.
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function classify(text: string, isWeekendCol: boolean): {
  day_type: Row["day_type"];
  cycle_day: number | null;
} {
  const m = text.match(DAY_RE);
  const n = m ? Number(m[1]) : null;
  if (n && n >= 1 && n <= 7) return { day_type: "class", cycle_day: n };
  if (BREAK_RE.test(text)) return { day_type: "holiday", cycle_day: null };
  if (isWeekendCol && !text.trim()) return { day_type: "weekend", cycle_day: null };
  return { day_type: text.trim() ? "event" : "weekend", cycle_day: null };
}

function parseSheet(ws: XLSX.WorkSheet, yearId: string): Row[] {
  const ref = ws["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const out: Row[] = [];

  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      const serial = cell && typeof cell.v === "number" ? cell.v : null;
      // date serials for this academic year fall in a known window
      if (serial === null || serial < 45000 || serial > 48000) continue;

      const annot = ws[XLSX.utils.encode_cell({ r: r + 1, c })];
      const text = annot && annot.v != null ? String(annot.v) : "";
      const isWeekendCol = c === range.s.c || c === range.s.c + 6; // dom / sáb
      const { day_type, cycle_day } = classify(text, isWeekendCol);

      out.push({
        academic_year_id: yearId,
        date: excelSerialToISO(serial),
        day_type,
        cycle_day,
        label: text.trim() ? text.trim().replace(DAY_RE, "").trim() || null : null,
      });
    }
  }
  return out;
}

async function main() {
  const [file, yearId] = process.argv.slice(2);
  if (!file || !yearId) {
    console.error('Usage: tsx scripts/import-calendar.ts <file.xlsx> <academic_year_id>');
    process.exit(1);
  }

  const wb = XLSX.readFile(file);
  const seen = new Map<string, Row>(); // dedupe by date, last write wins
  for (const name of wb.SheetNames) {
    for (const row of parseSheet(wb.Sheets[name], yearId)) {
      seen.set(row.date, row);
    }
  }
  const rows = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));

  const classDays = rows.filter((r) => r.cycle_day).length;
  console.log(`Parsed ${rows.length} dated cells (${classDays} class days).`);

  const { error } = await admin
    .from("calendar_days")
    .upsert(rows, { onConflict: "academic_year_id,date" });
  if (error) throw error;
  console.log(`Upserted ${rows.length} calendar_days. Review day_type before generating sessions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

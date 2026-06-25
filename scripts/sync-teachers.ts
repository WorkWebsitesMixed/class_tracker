/**
 * Syncs the teachers table from docentes_correo.xlsx:
 *   - Updates email for matched teachers
 *   - Deletes (with --delete) teachers not found in the file
 *   - Reports unmatched rows on both sides
 *
 * Usage:
 *   npx tsx scripts/sync-teachers.ts docentes_correo.xlsx [--delete] [--dry-run]
 *
 * Always do a --dry-run first to review what will change.
 */

import * as XLSX from "xlsx";
import { admin } from "./lib/db";

const args = process.argv.slice(2);
const xlsxPath = args.find((a) => !a.startsWith("--"))!;
const dryRun   = args.includes("--dry-run");
const doDelete = args.includes("--delete");

if (!xlsxPath) {
  console.error("Usage: npx tsx scripts/sync-teachers.ts <docentes.xlsx> [--delete] [--dry-run]");
  process.exit(1);
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function words(name: string): Set<string> {
  return new Set(normalize(name).split(/\s+/).filter(Boolean));
}

// Match if one word set is a subset of the other (handles extra middle names /
// compound names differing between the two files).
function isMatch(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  const [smaller, larger] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  const intersection = [...smaller].filter((w) => larger.has(w));
  // All words in the shorter name must appear in the longer one
  return intersection.length === smaller.size;
}

type DocEntry = { name: string; email: string; key: string };
type DbTeacher = { id: string; email: string; full_name: string; key: string };

async function main() {
  // ── load xlsx ───────────────────────────────────────────────────────────────

  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });

  const docentesList: DocEntry[] = rows
    .slice(1)
    .filter((r) => r[0]?.toString().trim())
    .map((r) => ({
      name:  r[0].toString().trim().toUpperCase(),
      email: r[1].toString().trim().toLowerCase(),
      key:   r[0].toString(),
    }));

  console.log(`Loaded ${docentesList.length} teachers from ${xlsxPath}`);

  // ── load DB teachers ─────────────────────────────────────────────────────────

  const { data: dbTeachers, error } = await admin
    .from("teachers")
    .select("id, email, full_name");
  if (error) throw error;

  const dbList: DbTeacher[] = dbTeachers.map((t) => ({
    ...t,
    key: t.full_name,
  }));

  console.log(`Found ${dbList.length} teachers in DB\n`);

  // ── match ────────────────────────────────────────────────────────────────────

  const matched: Array<{ db: DbTeacher; doc: DocEntry }> = [];
  const unmatchedDb  = new Set(dbList.map((t) => t.id));
  const unmatchedDoc = new Set(docentesList.map((d) => d.email));

  for (const db of dbList) {
    const doc = docentesList.find((d) => isMatch(d.key, db.key));
    if (doc) {
      matched.push({ db, doc });
      unmatchedDb.delete(db.id);
      unmatchedDoc.delete(doc.email);
    }
  }

  console.log(`Matched:    ${matched.length}`);
  console.log(`In DB only: ${unmatchedDb.size}  ${doDelete ? "(will delete)" : "(use --delete to remove)"}`);
  console.log(`In file only (no DB match): ${unmatchedDoc.size}\n`);

  // ── updates ──────────────────────────────────────────────────────────────────

  const toUpdate = matched.filter(({ db, doc }) =>
    normalize(db.email) !== normalize(doc.email),
  );

  console.log(`Email updates needed: ${toUpdate.length}`);
  for (const { db, doc } of toUpdate) {
    console.log(`  ${db.full_name}`);
    console.log(`    ${db.email}  →  ${doc.email}`);
  }

  if (!dryRun && toUpdate.length > 0) {
    for (const { db, doc } of toUpdate) {
      const { error } = await admin
        .from("teachers")
        .update({ email: doc.email })
        .eq("id", db.id);
      if (error) console.error(`  ✗ ${db.full_name}: ${error.message}`);
      else        console.log(`  ✓ Updated ${db.full_name}`);
    }
  }

  // ── deletes ──────────────────────────────────────────────────────────────────

  const toDelete = dbList.filter((t) => unmatchedDb.has(t.id));

  if (toDelete.length > 0) {
    console.log(`\nTeachers not in file (${toDelete.length}):`);
    for (const t of toDelete) console.log(`  ${t.full_name}  <${t.email}>`);

    if (!dryRun && doDelete) {
      const ids = toDelete.map((t) => t.id);
      // lessons.teacher_id has no cascade — delete lessons first, then teachers
      const { error: lErr } = await admin.from("lessons").delete().in("teacher_id", ids);
      if (lErr) { console.error("Delete lessons failed:", lErr.message); }
      else {
        const { error: tErr } = await admin.from("teachers").delete().in("id", ids);
        if (tErr) console.error("Delete teachers failed:", tErr.message);
        else      console.log(`✓ Deleted ${ids.length} teachers and their lessons`);
      }
    } else if (!doDelete) {
      console.log("  → Re-run with --delete to remove them.");
    }
  }

  // ── unmatched from file ──────────────────────────────────────────────────────

  if (unmatchedDoc.size > 0) {
    const unmatched = docentesList.filter((d) => unmatchedDoc.has(d.email));
    console.log(`\nIn file but no DB match (${unmatched.length}) — not in schedule import?`);
    for (const d of unmatched) console.log(`  ${d.name}  <${d.email}>`);
  }

  if (dryRun) console.log("\n[DRY RUN] No changes written. Re-run without --dry-run to apply.");
}

main().catch((e) => { console.error(e); process.exit(1); });

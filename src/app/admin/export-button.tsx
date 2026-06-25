"use client";

import type { AdminSession } from "@/lib/admin-queries";

const COLS: { key: keyof AdminSession; label: string }[] = [
  { key: "scheduled_start", label: "inicio" },
  { key: "scheduled_end", label: "fin" },
  { key: "teacher_name", label: "docente" },
  { key: "subject_name", label: "materia" },
  { key: "cycle_name", label: "grupo" },
  { key: "report_status", label: "estado" },
  { key: "reason_label", label: "motivo" },
  { key: "other_reason", label: "motivo_otro" },
  { key: "reported_at", label: "reportado_en" },
];

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function ExportButton({ rows, date }: { rows: AdminSession[]; date: string }) {
  function download() {
    const header = COLS.map((c) => c.label).join(",");
    const body = rows
      .map((r) => COLS.map((c) => esc(r[c.key] ?? (c.key === "report_status" ? "sin_reportar" : ""))).join(","))
      .join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cumplimiento-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      onClick={download}
      disabled={rows.length === 0}
      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
    >
      Exportar CSV ({rows.length})
    </button>
  );
}

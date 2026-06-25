import { requireStaff, getDay, getDailyCompliance, type AdminSession } from "@/lib/admin-queries";
import { FilterBar } from "./filter-bar";
import { ExportButton } from "./export-button";
import { Realtime } from "./realtime";

export const dynamic = "force-dynamic";

const TZ = "America/Bogota";
const todayTZ = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });

type Status = "all" | "given" | "missed" | "pending";

function statusOf(r: AdminSession): Exclude<Status, "all"> {
  if (!r.report_id) return "pending";
  return r.report_status as "given" | "missed";
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; status?: Status; teacher?: string; reason?: string }>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const date = sp.date || todayTZ();

  const [rows, summary] = await Promise.all([getDay(date), getDailyCompliance(date)]);

  // Options derived from the day's data (no extra round-trips).
  const teachers = [...new Map(rows.map((r) => [r.teacher_id, r.teacher_name])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const reasons = [...new Set(rows.filter((r) => r.reason_label).map((r) => r.reason_label!))].sort();

  const filtered = rows.filter((r) => {
    if (sp.status && sp.status !== "all" && statusOf(r) !== sp.status) return false;
    if (sp.teacher && r.teacher_id !== sp.teacher) return false;
    if (sp.reason && r.reason_label !== sp.reason) return false;
    return true;
  });

  const cards = [
    { label: "Total", value: summary.total, tone: "text-slate-900" },
    { label: "Dictadas", value: summary.given, tone: "text-emerald-600" },
    { label: "No dictadas", value: summary.missed, tone: "text-rose-600" },
    { label: "Sin reportar", value: summary.pending, tone: "text-amber-600" },
    {
      label: "Cumplimiento",
      value: summary.reported_pct != null ? `${summary.reported_pct}%` : "—",
      tone: "text-slate-900",
    },
  ];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <Realtime />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Cumplimiento diario</h1>
        <ExportButton rows={filtered} date={date} />
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{c.label}</p>
            <p className={`mt-1 text-3xl font-bold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </section>

      <FilterBar
        date={date}
        status={sp.status ?? "all"}
        teacher={sp.teacher ?? ""}
        reason={sp.reason ?? ""}
        teachers={teachers}
        reasons={reasons}
      />

      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Hora</th>
              <th className="px-4 py-3">Docente</th>
              <th className="px-4 py-3">Clase</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Motivo</th>
              <th className="px-4 py-3">Reportado</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const st = statusOf(r);
              return (
                <tr key={r.session_id} className="border-b border-slate-50 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{hm(r.scheduled_start)}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{r.teacher_name}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.subject_name} <span className="text-slate-400">· {r.cycle_name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        st === "given"
                          ? "bg-emerald-50 text-emerald-700"
                          : st === "missed"
                            ? "bg-rose-50 text-rose-700"
                            : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {st === "given" ? "Dictada" : st === "missed" ? "No dictada" : "Sin reportar"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.reason_label ?? r.other_reason ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                    {r.reported_at ? hm(r.reported_at) : "—"}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                  Sin registros para los filtros seleccionados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

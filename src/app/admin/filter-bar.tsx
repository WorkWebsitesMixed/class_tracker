"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

const sel = "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm";

export function FilterBar({
  date,
  status,
  teacher,
  reason,
  teachers,
  reasons,
}: {
  date: string;
  status: string;
  teacher: string;
  reason: string;
  teachers: { id: string; name: string }[];
  reasons: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={date}
        onChange={(e) => set("date", e.target.value)}
        className={sel}
      />
      <select value={status} onChange={(e) => set("status", e.target.value)} className={sel}>
        <option value="all">Todos los estados</option>
        <option value="given">Dictadas</option>
        <option value="missed">No dictadas</option>
        <option value="pending">Sin reportar</option>
      </select>
      <select value={teacher} onChange={(e) => set("teacher", e.target.value)} className={sel}>
        <option value="">Todos los docentes</option>
        {teachers.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select value={reason} onChange={(e) => set("reason", e.target.value)} className={sel}>
        <option value="">Todos los motivos</option>
        {reasons.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {(status !== "all" || teacher || reason) && (
        <button
          onClick={() => router.push(`${pathname}?date=${date}`)}
          className="text-sm text-slate-400 underline"
        >
          limpiar
        </button>
      )}
    </div>
  );
}

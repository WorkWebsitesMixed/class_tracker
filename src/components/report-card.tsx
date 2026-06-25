"use client";

import { useState, useTransition } from "react";
import { submitReport } from "@/app/actions";
import type { Reason, SessionCard } from "@/lib/queries";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Bogota",
  });

export function ReportCard({
  card,
  reasons,
}: {
  card: SessionCard;
  reasons: Reason[];
}) {
  const [pending, startTransition] = useTransition();
  const [phase, setPhase] = useState<"idle" | "missed" | "done">(
    card.report_id ? "done" : "idle",
  );
  const [done, setDone] = useState<"given" | "missed" | null>(card.report_status);
  const [error, setError] = useState<string | null>(null);
  const [otherReason, setOtherReason] = useState("");

  function send(
    status: "given" | "missed",
    reasonId?: string,
    other?: string,
  ) {
    setError(null);
    startTransition(async () => {
      const res = await submitReport({
        sessionId: card.session_id,
        status,
        reasonId,
        otherReason: other,
      });
      if (res.ok) {
        setDone(status);
        setPhase("done");
      } else setError(res.error);
    });
  }

  return (
    <div className="rounded-3xl bg-white shadow-lg ring-1 ring-black/5 p-6 sm:p-8">
      <p className="text-sm font-medium text-slate-500">
        {card.period_name ? `${card.period_name} · ` : ""}
        {time(card.scheduled_start)}–{time(card.scheduled_end)}
      </p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
        {card.subject_name}
      </h2>
      <p className="mt-1 text-lg text-slate-600">
        {card.cycle_name}
        {card.room_name ? ` · ${card.room_name}` : ""}
      </p>

      {phase === "done" ? (
        <div
          className={`mt-6 rounded-2xl px-5 py-4 text-center text-lg font-semibold ${
            done === "given"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-amber-50 text-amber-700"
          }`}
        >
          {done === "given" ? "✓ Clase dictada" : "✓ Reporte enviado (no dictada)"}
          <button
            onClick={() => setPhase("idle")}
            className="ml-3 text-sm font-medium text-slate-400 underline"
          >
            cambiar
          </button>
        </div>
      ) : phase === "missed" ? (
        <div className="mt-6 space-y-3">
          <p className="text-sm font-medium text-slate-600">¿Motivo?</p>
          {reasons.map((r) => (
            <button
              key={r.id}
              disabled={pending}
              onClick={() =>
                r.label.toLowerCase().startsWith("otro")
                  ? null
                  : send("missed", r.id)
              }
              className="block w-full rounded-xl border border-slate-200 px-4 py-3 text-left text-base font-medium text-slate-700 active:bg-slate-100 disabled:opacity-50"
            >
              {r.label}
            </button>
          ))}
          <div className="flex gap-2 pt-1">
            <input
              value={otherReason}
              onChange={(e) => setOtherReason(e.target.value)}
              placeholder="Otro motivo…"
              className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-base"
            />
            <button
              disabled={pending || !otherReason.trim()}
              onClick={() => send("missed", undefined, otherReason.trim())}
              className="rounded-xl bg-slate-900 px-5 text-base font-semibold text-white disabled:opacity-40"
            >
              Enviar
            </button>
          </div>
          <button
            onClick={() => setPhase("idle")}
            className="pt-1 text-sm text-slate-400 underline"
          >
            cancelar
          </button>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            disabled={pending}
            onClick={() => send("given")}
            className="rounded-2xl bg-emerald-600 py-6 text-xl font-bold text-white active:bg-emerald-700 disabled:opacity-50"
          >
            Clase dictada
          </button>
          <button
            disabled={pending}
            onClick={() => setPhase("missed")}
            className="rounded-2xl bg-rose-600 py-6 text-xl font-bold text-white active:bg-rose-700 disabled:opacity-50"
          >
            No dictada
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    </div>
  );
}

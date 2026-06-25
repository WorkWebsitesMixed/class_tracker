import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getDashboardCard,
  getPendingToday,
  getReasons,
  type SessionCard,
} from "@/lib/queries";
import { ReportCard } from "@/components/report-card";
import { PushManager } from "@/components/push-manager";

export const dynamic = "force-dynamic"; // always reflect the current time

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Bogota",
  });

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const supabase = await createSupabaseServer();
  const { data: auth } = await supabase.auth.getUser();

  if (!auth.user) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 p-6 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Registro de clases</h1>
        <Link
          href="/login"
          className="rounded-2xl bg-slate-900 px-8 py-4 text-lg font-semibold text-white"
        >
          Ingresar con Google
        </Link>
      </main>
    );
  }

  const { session } = await searchParams;
  const [card, reasons, pending, me] = await Promise.all([
    getDashboardCard(session),
    getReasons(),
    getPendingToday(),
    supabase.from("teachers").select("role").eq("email", auth.user.email!).maybeSingle(),
  ]);
  const isStaff = me.data?.role === "coordinator" || me.data?.role === "admin";

  return (
    <main className="mx-auto min-h-dvh max-w-md space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between pt-2">
        <h1 className="text-lg font-semibold text-slate-900">Mis clases</h1>
        <div className="flex items-center gap-3">
          {isStaff && (
            <Link href="/admin" className="text-sm font-medium text-slate-600 underline">
              Admin
            </Link>
          )}
          <span className="text-sm text-slate-400">{auth.user.email}</span>
        </div>
      </header>

      {card ? (
        <ReportCard card={card} reasons={reasons} />
      ) : (
        <div className="rounded-3xl bg-white p-8 text-center text-slate-500 shadow-sm ring-1 ring-black/5">
          No hay clases terminadas pendientes de reporte.
        </div>
      )}

      <PushManager />

      {pending.length > 0 && (
        <section>
          <h2 className="px-1 pb-2 text-sm font-medium text-slate-500">
            Pendientes hoy
          </h2>
          <ul className="space-y-2">
            {pending
              .filter((p: SessionCard) => p.session_id !== card?.session_id)
              .map((p: SessionCard) => (
                <li key={p.session_id}>
                  <Link
                    href={`/?session=${p.session_id}`}
                    className="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5"
                  >
                    <span className="font-medium text-slate-800">
                      {p.subject_name}{" "}
                      <span className="text-slate-400">· {p.cycle_name}</span>
                    </span>
                    <span className="text-sm text-slate-400">
                      {time(p.scheduled_start)}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}
    </main>
  );
}

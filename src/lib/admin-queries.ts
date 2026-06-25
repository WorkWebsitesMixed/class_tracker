import { redirect } from "next/navigation";
import { createSupabaseServer } from "./supabase/server";

export type AdminSession = {
  session_id: string;
  date: string;
  scheduled_start: string;
  scheduled_end: string;
  teacher_id: string;
  teacher_name: string;
  subject_name: string;
  cycle_name: string;
  period_name: string | null;
  report_id: string | null;
  report_status: "given" | "missed" | null;
  reason_label: string | null;
  other_reason: string | null;
  reported_at: string | null;
};

export type DailyCompliance = {
  total: number;
  reported: number;
  given: number;
  missed: number;
  pending: number;
  reported_pct: number | null;
};

/** Gate an admin route to coordinator/admin roles. Redirects otherwise. */
export async function requireStaff() {
  const supabase = await createSupabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.email) redirect("/login");

  const { data: me } = await supabase
    .from("teachers")
    .select("id, full_name, role")
    .eq("email", auth.user.email)
    .single();

  if (!me || (me.role !== "coordinator" && me.role !== "admin")) redirect("/");
  return { supabase, me };
}

export async function getDay(date: string): Promise<AdminSession[]> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("v_session_cards")
    .select(
      "session_id,date,scheduled_start,scheduled_end,teacher_id,teacher_name,subject_name,cycle_name,period_name,report_id,report_status,reason_label,other_reason,reported_at",
    )
    .eq("date", date)
    .order("scheduled_start", { ascending: true })
    .returns<AdminSession[]>();
  if (error) throw error;
  return data ?? [];
}

export async function getDailyCompliance(date: string): Promise<DailyCompliance> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("v_daily_compliance")
    .select("total,reported,given,missed,pending,reported_pct")
    .eq("date", date)
    .maybeSingle();
  if (error) throw error;
  return (
    data ?? { total: 0, reported: 0, given: 0, missed: 0, pending: 0, reported_pct: null }
  );
}

import { createSupabaseServer } from "./supabase/server";

export type SessionCard = {
  session_id: string;
  date: string;
  scheduled_start: string;
  scheduled_end: string;
  state: "pending" | "reported" | "cancelled";
  teacher_id: string;
  teacher_name: string;
  subject_name: string;
  cycle_name: string;
  room_name: string | null;
  period_name: string | null;
  report_id: string | null;
  report_status: "given" | "missed" | null;
};

export type Reason = { id: string; label: string };

const TZ = "America/Bogota";

/** Today's date (school timezone) as YYYY-MM-DD. */
function todayInTZ(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The context-aware card: the most recently *completed* class today for the
 * signed-in teacher. RLS scopes rows to that teacher. If `sessionId` is given
 * (deep link from a notification) that exact card is returned instead.
 */
export async function getDashboardCard(
  sessionId?: string,
): Promise<SessionCard | null> {
  const supabase = await createSupabaseServer();
  let q = supabase.from("v_session_cards").select("*");

  if (sessionId) {
    q = q.eq("session_id", sessionId);
  } else {
    q = q
      .eq("date", todayInTZ())
      .lte("scheduled_end", new Date().toISOString())
      .order("scheduled_end", { ascending: false })
      .limit(1);
  }

  const { data, error } = await q.returns<SessionCard[]>();
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Remaining unreported classes today, for the "what's left" list. */
export async function getPendingToday(): Promise<SessionCard[]> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("v_session_cards")
    .select("*")
    .eq("date", todayInTZ())
    .is("report_id", null)
    .order("scheduled_start", { ascending: true })
    .returns<SessionCard[]>();
  if (error) throw error;
  return data ?? [];
}

export async function getReasons(): Promise<Reason[]> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase
    .from("report_reasons")
    .select("id,label")
    .eq("is_active", true)
    .order("sort_order")
    .returns<Reason[]>();
  if (error) throw error;
  return data ?? [];
}

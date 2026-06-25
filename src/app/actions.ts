"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";

export type ReportResult = { ok: true } | { ok: false; error: string };

/**
 * One-tap report. `given` needs nothing else; `missed` needs a reason_id or
 * free-text. RLS guarantees the teacher can only write their own report.
 */
export async function submitReport(input: {
  sessionId: string;
  status: "given" | "missed";
  reasonId?: string | null;
  otherReason?: string | null;
}): Promise<ReportResult> {
  const supabase = await createSupabaseServer();

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.email) return { ok: false, error: "Not authenticated" };

  const { data: teacher } = await supabase
    .from("teachers")
    .select("id")
    .eq("email", auth.user.email)
    .single();
  if (!teacher) return { ok: false, error: "No teacher profile linked to this account" };

  if (input.status === "missed" && !input.reasonId && !input.otherReason) {
    return { ok: false, error: "A reason is required for a missed class" };
  }

  // Upsert so a mistaken tap can be corrected (unique on session_id).
  const { error } = await supabase.from("class_reports").upsert(
    {
      session_id: input.sessionId,
      teacher_id: teacher.id,
      status: input.status,
      reason_id: input.status === "missed" ? input.reasonId ?? null : null,
      other_reason: input.status === "missed" ? input.otherReason ?? null : null,
      source: "app",
    },
    { onConflict: "session_id" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  return { ok: true };
}

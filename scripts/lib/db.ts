import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
}

// Service-role client: bypasses RLS. Import scripts only — never ship to client.
export const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Upsert a dimension row by its aSc code, returning its id. */
export async function upsertByCode(
  table: "subjects" | "rooms" | "cycles",
  ascCode: string,
  name: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .upsert({ asc_code: ascCode, name }, { onConflict: "asc_code" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// Edge Function: notify teachers whose class block just ended and is unreported.
// Invoked every few minutes by pg_cron (see 0002_notifications.sql).
//
// Secrets (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@school)
//   APP_URL (e.g. https://tracker.school.edu.co)
//   GOOGLE_CHAT_WEBHOOK_URL (optional fallback)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const APP_URL = Deno.env.get("APP_URL") ?? "";
const CHAT_WEBHOOK = Deno.env.get("GOOGLE_CHAT_WEBHOOK_URL");

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async () => {
  const { data: due, error } = await supabase.rpc("sessions_to_notify", {
    p_window_minutes: 20,
  });
  if (error) return json({ error: error.message }, 500);
  if (!due?.length) return json({ sent: 0 });

  let sent = 0;
  for (const s of due) {
    const deepLink = `${APP_URL}/?session=${s.session_id}`;
    const title = "¿Dictaste tu clase?";
    const body = `${s.subject_name} · ${s.cycle_name}`;

    // 1. Web Push to every device the teacher registered.
    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("teacher_id", s.teacher_id);

    await Promise.all(
      (subs ?? []).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title, body, url: deepLink }),
          );
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          }
        }
      }),
    );

    // 2. Google Chat fallback (optional).
    if (CHAT_WEBHOOK) {
      await fetch(CHAT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${body} — reportar: ${deepLink}` }),
      }).catch(() => {});
    }

    await supabase
      .from("class_sessions")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", s.session_id);
    sent++;
  }

  return json({ sent });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

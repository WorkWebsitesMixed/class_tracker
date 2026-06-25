"use client";

import { useEffect, useState } from "react";
import { savePushSubscription } from "@/app/actions";

const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

// VAPID public key (base64url) -> Uint8Array for PushManager.subscribe.
function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type State = "unsupported" | "default" | "granted" | "denied" | "busy";

export function PushManager() {
  const [state, setState] = useState<State>("default");

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !VAPID
    ) {
      setState("unsupported");
      return;
    }
    setState(Notification.permission as State);
  }, []);

  async function enable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission as State);
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID!),
      });
      const json = sub.toJSON();
      await savePushSubscription({
        endpoint: sub.endpoint,
        p256dh: json.keys!.p256dh,
        auth: json.keys!.auth,
      });
      setState("granted");
    } catch {
      setState("default");
    }
  }

  if (state === "unsupported" || state === "granted") return null;

  return (
    <button
      onClick={enable}
      disabled={state === "busy" || state === "denied"}
      className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-600 disabled:opacity-50"
    >
      {state === "denied"
        ? "Notificaciones bloqueadas (actívalas en el navegador)"
        : state === "busy"
          ? "Activando…"
          : "🔔 Activar recordatorios de reporte"}
    </button>
  );
}

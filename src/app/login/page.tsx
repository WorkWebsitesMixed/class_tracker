"use client";

import { createSupabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  async function signIn() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${location.origin}/auth/callback`,
        // Restrict the Google account picker to the school workspace domain.
        queryParams: { hd: process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN ?? "" },
      },
    });
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-8 p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Registro de clases</h1>
        <p className="mt-2 text-slate-500">Ingresa con tu cuenta institucional</p>
      </div>
      <button
        onClick={signIn}
        className="rounded-2xl bg-slate-900 px-8 py-4 text-lg font-semibold text-white active:bg-slate-700"
      >
        Ingresar con Google
      </button>
    </main>
  );
}

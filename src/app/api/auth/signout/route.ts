import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/infrastructure/supabase/supabaseClients";

export async function POST(): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, message: "Supabase が設定されていません。" },
      { status: 500 },
    );
  }
  const supabase = await createSupabaseServerClient({
    url,
    anonKey,
    serviceRoleKey,
  });
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}

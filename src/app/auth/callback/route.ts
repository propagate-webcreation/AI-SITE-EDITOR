import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/infrastructure/supabase/supabaseClients";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";
  const errorParam = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return redirectToLoginWithError(
      url,
      "Supabase 環境変数が未設定です (.env.local を確認してください)",
    );
  }

  if (errorParam) {
    return redirectToLoginWithError(
      url,
      errorDescription ?? errorParam,
    );
  }

  if (!code) {
    return redirectToLoginWithError(url, "認証コードがありません。");
  }

  const supabase = await createSupabaseServerClient({
    url: supabaseUrl,
    anonKey,
    serviceRoleKey,
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return redirectToLoginWithError(url, error.message);
  }

  const redirectTo = safeRelativePath(next, url.origin);
  return NextResponse.redirect(`${url.origin}${redirectTo}`);
}

function redirectToLoginWithError(
  url: URL,
  message: string,
): Response {
  const redirect = new URL("/login", url.origin);
  redirect.searchParams.set("error", message);
  return NextResponse.redirect(redirect);
}

function safeRelativePath(path: string, origin: string): string {
  if (!path.startsWith("/")) return "/";
  // open redirect 回避: //evil.com のような入力を弾く
  if (path.startsWith("//")) return "/";
  try {
    const parsed = new URL(path, origin);
    if (parsed.origin !== origin) return "/";
    return parsed.pathname + parsed.search;
  } catch {
    return "/";
  }
}

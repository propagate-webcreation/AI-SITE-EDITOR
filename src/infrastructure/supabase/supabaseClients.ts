import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

/**
 * 認可された director 本人の権限でアクセスする server-side クライアント。
 * RLS が適用される。
 */
export async function createSupabaseServerClient(config: SupabaseConfig) {
  const cookieStore = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      get(name: string): string | undefined {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Route Handler / Server Component からの set 不可パターンを許容
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          /* noop */
        }
      },
    },
  });
}

/**
 * RLS を無視する service_role クライアント。
 * 排他制御などドメイン内部の処理でのみ使う。
 */
export function createSupabaseAdminClient(config: SupabaseConfig) {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

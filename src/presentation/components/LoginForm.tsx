"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

interface LoginFormProps {
  supabaseUrl: string;
  supabaseAnonKey: string;
  nextPath: string;
}

export function LoginForm({
  supabaseUrl,
  supabaseAnonKey,
  nextPath,
}: LoginFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleGoogleSignIn(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(
        nextPath || "/",
      )}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });
      if (oauthError) {
        setError(oauthError.message);
      }
      // 成功時はブラウザが Google に遷移するので後続処理は不要
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm bg-[#1f1f22] border border-[#3a3a3f] rounded-lg p-6 space-y-4 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.6)]">
      <span className="text-xs text-[#70707a] tracking-wider">
        AI-SITE-EDITOR
      </span>
      <h1 className="text-lg font-semibold text-[#f0f0f2]">
        ディレクターログイン
      </h1>
      <p className="text-xs text-[#a9a9b0] leading-relaxed">
        Propagate の Google アカウントでサインインしてください。
      </p>
      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={loading}
        className="w-full py-2.5 rounded-md bg-white text-[#0b0b0d] text-sm font-semibold disabled:bg-[#2b2b30] disabled:text-[#55555c] flex items-center justify-center gap-2 hover:bg-[#f0f0f2] transition"
      >
        <GoogleIcon />
        {loading ? "リダイレクト中..." : "Google でサインイン"}
      </button>
      {error && (
        <p className="text-xs text-red-300 bg-red-500/5 border border-red-500/30 rounded-md p-2">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

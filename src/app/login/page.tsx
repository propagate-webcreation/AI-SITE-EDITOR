import { LoginForm } from "@/presentation/components/LoginForm";

interface LoginPageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return (
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-sm text-neutral-300">
          <h1 className="text-lg font-semibold mb-2">ログイン設定が未完了</h1>
          <p>
            Supabase 環境変数 (NEXT_PUBLIC_SUPABASE_URL /
            NEXT_PUBLIC_SUPABASE_ANON_KEY) が設定されていません。
            <br />
            <code>supabase/README.md</code> を参照してセットアップしてください。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4">
        <LoginForm
          supabaseUrl={url}
          supabaseAnonKey={anonKey}
          nextPath={params.next ?? "/"}
        />
        {params.error && (
          <p className="text-xs text-red-400 max-w-sm text-center">
            {params.error}
          </p>
        )}
      </div>
    </main>
  );
}

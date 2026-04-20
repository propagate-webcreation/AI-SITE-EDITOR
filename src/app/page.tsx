import { Sandbox } from "@vercel/sandbox";
import { DirectorWorkspace } from "@/presentation/components/DirectorWorkspace";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/infrastructure/supabase/supabaseClients";
import { SupabaseSessionRepository } from "@/infrastructure/supabase/supabaseSessionRepository";
import type { Session } from "@/domain/models";
import type { SessionRepositoryPort } from "@/domain/ports";

export default async function HomePage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let directorEmail: string | null = null;
  let initialSession = null;

  if (url && anonKey && serviceRoleKey) {
    const supabase = await createSupabaseServerClient({
      url,
      anonKey,
      serviceRoleKey,
    });
    const { data } = await supabase.auth.getUser();
    directorEmail = data.user?.email ?? null;

    if (data.user) {
      const admin = createSupabaseAdminClient({
        url,
        anonKey,
        serviceRoleKey,
      });
      const repo = new SupabaseSessionRepository(admin);
      const active = await repo.listActiveByDirector(data.user.id);
      const latest = active[0];
      if (latest) {
        if (new Date(latest.expiresAt) <= new Date()) {
          await markSessionExpired(repo, latest);
        } else if (!(await isSandboxAlive(latest.sandboxId))) {
          await markSessionExpired(repo, latest);
        } else {
          initialSession = {
            sessionId: latest.id,
            recordNumber: latest.recordNumber,
            partnerName: latest.partnerName,
            contractPlan: latest.contractPlan,
            githubRepoUrl: latest.githubRepoUrl,
            previewUrl: latest.previewUrl,
            expiresAt: latest.expiresAt.toISOString(),
          };
        }
      }
    }
  }

  return (
    <DirectorWorkspace
      directorEmail={directorEmail}
      initialSession={initialSession}
    />
  );
}

/**
 * Vercel API で Sandbox が生きているか確認する。
 * preview URL の HTTP 応答は middleware リダイレクト等の影響で false 判定されやすいので、
 * Vercel 側の API で sandbox レコードの存在だけを見る。
 */
async function isSandboxAlive(sandboxId: string): Promise<boolean> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) return true; // 設定不足時は真として通す
  try {
    await Sandbox.get({ token, teamId, projectId, sandboxId });
    return true;
  } catch {
    return false;
  }
}

async function markSessionExpired(
  repo: SessionRepositoryPort,
  session: Session,
): Promise<void> {
  try {
    await repo.updateStatus({
      id: session.id,
      status: "expired",
      closedAt: new Date(),
    });
  } catch {
    /* best effort */
  }
}

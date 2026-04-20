import type { VercelPort } from "@/domain/ports";

export interface VercelClientConfig {
  token: string;
  teamId?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  verifyTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface VercelDeployment {
  uid?: string;
  id?: string;
  url?: string;
  alias?: string[];
  readyState?: string;
  state?: string;
  createdAt?: number;
  meta?: {
    githubCommitSha?: string;
    gitlabCommitSha?: string;
    bitbucketCommitSha?: string;
  };
}

interface VercelDeploymentsResponse {
  deployments?: VercelDeployment[];
}

export class VercelClient implements VercelPort {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: VercelClientConfig) {
    if (!config.token) {
      throw new Error("VercelClient: token が未設定です。");
    }
    this.baseUrl = config.baseUrl ?? "https://api.vercel.com";
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.maxWaitMs = config.maxWaitMs ?? 900_000;
    this.verifyTimeoutMs = config.verifyTimeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async waitForDeploymentByCommit(params: {
    projectName: string;
    commitSha: string;
  }): Promise<string> {
    if (!params.commitSha || params.commitSha.length < 7) {
      throw new Error(
        `VercelClient: commit_sha が不正です (${params.commitSha})`,
      );
    }

    const listUrl = this.buildDeploymentListUrl(params);
    const start = Date.now();
    let lastState = "";
    let lastDeploymentId = "";

    while (Date.now() - start < this.maxWaitMs) {
      const matched = await this.findMatchingDeployments(listUrl, params.commitSha);
      if (matched.length > 0) {
        const latest = matched[0];
        if (!latest) {
          throw new Error("VercelClient: 内部エラー、マッチする deployment が空でした");
        }
        const state = (latest.readyState ?? latest.state ?? "").toUpperCase();
        lastState = state;
        lastDeploymentId = latest.uid ?? latest.id ?? "";
        if (state === "READY") {
          return this.resolveDeploymentUrl(latest);
        }
        if (state === "ERROR" || state === "CANCELED") {
          throw new Error(
            `Vercel deployment が ${state} commit=${params.commitSha.slice(0, 7)} deployment=${lastDeploymentId}`,
          );
        }
      }
      await this.sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Vercel deployment が時間内に READY になりませんでした commit=${params.commitSha.slice(0, 7)} last_state=${lastState} last_id=${lastDeploymentId}`,
    );
  }

  async verifyDeploymentUrl(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.verifyTimeoutMs);
    try {
      const resp = await this.fetchImpl(url, { signal: controller.signal });
      return resp.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildDeploymentListUrl(params: {
    projectName: string;
    commitSha: string;
  }): string {
    const search = new URLSearchParams();
    if (this.config.teamId) search.set("teamId", this.config.teamId);
    search.set("app", params.projectName);
    search.set("meta-githubCommitSha", params.commitSha);
    search.set("limit", "20");
    return `${this.baseUrl}/v6/deployments?${search.toString()}`;
  }

  private async findMatchingDeployments(
    listUrl: string,
    commitSha: string,
  ): Promise<VercelDeployment[]> {
    const resp = await this.fetchImpl(listUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    if (!resp.ok) return [];

    const data = (await resp.json()) as VercelDeploymentsResponse;
    const deployments = data.deployments ?? [];
    const target = commitSha.slice(0, 40);
    const matching = deployments.filter((d) => {
      const meta = d.meta ?? {};
      const sha =
        meta.githubCommitSha ??
        meta.gitlabCommitSha ??
        meta.bitbucketCommitSha ??
        "";
      return sha.startsWith(target);
    });
    matching.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return matching;
  }

  private resolveDeploymentUrl(dep: VercelDeployment): string {
    const aliases = dep.alias ?? [];
    if (aliases.length > 0 && aliases[0]) {
      return `https://${aliases[0]}`;
    }
    const url = dep.url ?? "";
    if (!url) {
      throw new Error("VercelClient: READY deployment に URL がありません");
    }
    return `https://${url}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

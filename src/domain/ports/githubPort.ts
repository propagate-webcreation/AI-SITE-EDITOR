export interface GitHubPushResult {
  commitSha: string;
  branch: string;
}

export interface GitHubPort {
  authenticatedHttpsCloneUrl(cloneUrl: string): string;

  shallowCloneRepoIntoSiteDir(params: {
    repoUrl: string;
    siteDir: string;
  }): Promise<void>;

  pushToGitHubForce(params: {
    siteDir: string;
    repoUrl: string;
    commitMessage: string;
  }): Promise<GitHubPushResult>;
}

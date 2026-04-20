export interface VercelPort {
  waitForDeploymentByCommit(params: {
    projectName: string;
    commitSha: string;
  }): Promise<string>;

  verifyDeploymentUrl(url: string): Promise<boolean>;
}

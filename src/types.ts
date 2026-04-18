export interface RepoEntry {
  name: string;
  originPath: string;
  worktreePath: string;
  branch: string;
}

export interface Spec {
  name: string;
  description: string;
  featureBranch: string;
  status: 'draft' | 'active' | 'completed';
  agentCommand: string;
  repos: RepoEntry[];
  createdAt: string;
}

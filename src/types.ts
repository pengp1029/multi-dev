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
  projectName?: string;      // 归属项目；缺省视为 Ungrouped
}

export interface Project {
  name: string;              // 唯一标识（文件名 slug）
  description?: string;
  features: string[];        // 归属的 spec 名称列表（冗余，便于查询）
  createdAt: string;
}

export type SpecStatus = 'working' | 'waiting_confirm' | 'done' | 'idle';

export interface SpecState {
  status: SpecStatus;
  message?: string;          // hook 传入的简短说明
  updatedAt: string;         // ISO 时间戳
}

export const UNGROUPED_PROJECT = 'Ungrouped';

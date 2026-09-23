export type FoundationProjectStatus = "active" | "attention" | "paused";

export interface FoundationProject {
  id: string;
  name: string;
  description: string;
  status: FoundationProjectStatus;
  updatedAt: string;
  owner: string;
  activeTasks: number;
  blockedTasks: number;
  cloudSync: boolean;
}

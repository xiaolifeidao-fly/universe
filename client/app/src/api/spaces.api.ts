import { request } from "@/api/client";

export interface SpaceSummary {
  code: string;
  name: string;
  canWrite: boolean;
  canManage: boolean;
}

/** 当前用户能进的空间。移动端据此提供切换，而不是让人手输业务线编码。 */
export async function listSpaces(): Promise<SpaceSummary[]> {
  const views = await request<SpaceSummary[] | null>("/spaces");
  return (views ?? []).map((view) => ({
    code: view.code,
    name: view.name?.trim() || view.code,
    canWrite: Boolean(view.canWrite),
    canManage: Boolean(view.canManage),
  }));
}

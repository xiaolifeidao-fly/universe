import { request } from "@/api/client";

export interface DeliveryProgram {
  programId: number;
  name: string;
  summary: string;
  gitEnabled: boolean;
  gitRemoteName: string;
  gitBaseBranch: string;
  canWrite: boolean;
}

export interface DeliveryItem {
  itemKey: string;
  title: string;
  status: string;
  phase: string;
  progress: number;
  dependsOnItemKeys: string[];
}

interface DeliveryItemPage {
  total: number;
  data: DeliveryItem[];
}

export function listDeliveryPrograms() {
  return request<DeliveryProgram[]>("/delivery/programs");
}

export async function listDeliveryItems(programId: number) {
  const page = await request<DeliveryItemPage>(`/delivery/items?programId=${encodeURIComponent(String(programId))}&pageIndex=1&pageSize=200`);
  return page.data ?? [];
}

import type { Metadata } from "next";
import { fetchOverview } from "@/utils/portal.server";
import { ContactPanel } from "@/components/contact/ContactPanel";

/**
 * ISR：60 秒重新生成一次。
 *
 * 目录和价格是运营改的，不是实时数据 —— 一分钟的陈旧换来的是「每分钟只打一次
 * 后端」，而后端那边还有一层 30 秒缓存，两层加起来门户被爬也压不到数据库。
 *
 * 代价说清楚：构建时如果连不上后端，这一页会被预渲染成空态，
 * 直到部署后第一个访问触发重新生成。要避开这一秒，就让 CI 构建时能连到
 * SERVER_TARGET。
 */
export const revalidate = 60;


export const metadata: Metadata = {
  title: "联系我们",
  description: "企业采购、批量额度、接入协助。留一条，我们直接回你留的联系方式。",
};

export default async function ContactPage() {
  const overview = await fetchOverview();
  return <ContactPanel overview={overview} />;
}

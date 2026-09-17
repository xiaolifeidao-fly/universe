import type { Metadata } from "next";
import { fetchOverview } from "@/utils/portal.server";
import { ContactPanel } from "@/components/contact/ContactPanel";

/**
 * 数据缓存 60 秒。
 *
 * 目录和价格是运营改的，不是实时数据 —— 一分钟的陈旧换来的是「每分钟只打一次
 * 后端」，而后端那边还有一层 30 秒缓存，两层加起来门户被爬也压不到数据库。
 *
 * 页面本身不再是构建期预渲染的：根布局要在**运行时**读站点配置（控制台地址、
 * 联系方式），那一句 noStore() 把四个页面都变成「每次请求渲一遍」
 * （见 utils/site.server.ts）。缓存的是取数不是渲染，后端的压力没变，
 * 顺带还甩掉了原先那个坑 —— 构建时连不上后端就会把空态烙进预渲染的 HTML。
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

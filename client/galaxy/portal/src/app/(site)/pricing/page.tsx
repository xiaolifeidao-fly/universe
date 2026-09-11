import type { Metadata } from "next";
import { fetchOverview } from "@/utils/portal.server";
import { PricingBoard } from "@/components/pricing/PricingBoard";

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
  title: "定价",
  description: "买的是额度不是月份。输入、输出、缓存读各有各的单价，各扣各的余额；额度包一次买断，到期先冻结再清算。",
};

export default async function PricingPage() {
  const overview = await fetchOverview();
  return <PricingBoard overview={overview} />;
}

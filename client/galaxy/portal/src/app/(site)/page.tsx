import { fetchOverview } from "@/utils/portal.server";
import { Hero } from "@/components/home/Hero";
import { PriceTicker } from "@/components/home/PriceTicker";
import { CtaBand, Features, HomeFaq, ModelPeek, Steps } from "@/components/home/HomeSections";

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


/**
 * 首页。服务端组件 —— 目录、价格、统计都要进首屏 HTML：
 * 一个搜不到自家模型和价格的门户没有存在的意义。
 */
export default async function HomePage() {
  const overview = await fetchOverview();

  return (
    <>
      <Hero overview={overview} />
      <PriceTicker models={overview.models} />
      <Steps overview={overview} />
      <Features overview={overview} />
      <ModelPeek models={overview.models} />
      <HomeFaq />
      <div style={{ paddingBlock: "clamp(32px, 5vw, 72px)" }}>
        <CtaBand />
      </div>
    </>
  );
}

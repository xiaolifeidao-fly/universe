import { fetchOverview } from "@/utils/portal.server";
import { Hero } from "@/components/home/Hero";
import { PriceTicker } from "@/components/home/PriceTicker";
import { CtaBand, Features, HomeFaq, ModelPeek, Steps } from "@/components/home/HomeSections";

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

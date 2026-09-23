import type { ReactNode } from "react";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import { PortalOpenTracker } from "@/components/site/PortalOpenTracker";

/**
 * 门户外壳。四个页面共用一套顶栏与页脚 —— 它们是站点身份的一部分，
 * 每页各写一遍迟早会漂。
 */
export default function SiteLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <PortalOpenTracker />
      <Header />
      <main>{children}</main>
      {/* 年份在服务端算，随 RSC 载荷发下去 —— 客户端不再自己取一次 new Date()，
          跨年那一夜就不会出现服务端 2026、浏览器 2027 的水合不一致。 */}
      <Footer year={new Date().getFullYear()} />
    </>
  );
}

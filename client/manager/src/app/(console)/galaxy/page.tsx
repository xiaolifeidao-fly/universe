import { redirect } from "next/navigation";

// 共享算力池本身是菜单不是页面：侧栏里它只负责展开那一串子页面。
// 老书签和直接敲进来的 /galaxy 落到第一个子页面上，而不是一个空白页。
export default function GalaxyPage() {
  redirect("/galaxy/pool");
}

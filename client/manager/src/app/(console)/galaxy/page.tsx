import { redirect } from "next/navigation";

// 共享算力池本身是菜单不是页面：侧栏里它只负责展开那一串子页面。
// 老书签和直接敲进来的 /galaxy 落到运营总览上 —— 那一页回答的正是
// 「今天有没有事要处理」，是这一串页面里唯一适合当落点的。
export default function GalaxyPage() {
  redirect("/galaxy/overview");
}

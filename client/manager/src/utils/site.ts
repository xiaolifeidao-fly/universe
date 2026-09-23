/**
 * 应用挂在站点的哪一段下（线上是 `/manager`）。
 *
 * 唯一数据源是 next.config.mjs 里的 `BASE_PATH`，它同时决定了页面地址、`_next` 静态资源
 * 前缀和这里；这个文件只负责把构建期内联进来的那个值取出来给业务代码用。
 *
 * 只有「自己手拼绝对路径」的地方需要它：页面跳转走 next/navigation，`_next` 与 `public/`
 * 由 Next 自己加前缀，都不用管。usePathname() 返回的是**去掉前缀之后**的路径，
 * 所以菜单高亮那类比较照旧写 `/galaxy/pool`，不要在那里拼 basePath。
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

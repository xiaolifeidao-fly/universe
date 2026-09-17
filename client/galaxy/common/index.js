const products = Object.freeze({
  // home 是登录后的落点，也是外壳导航的第一项。Nova 的首页回答「现在在不在共享、
  // 今天赚了多少」，所以叫 today 而不是 overview —— 路由名和页面标题保持一致，
  // 免得日志里出现「用户停在 overview」而界面上根本没有这个词。
  //
  // basePath 是这个端挂在站点的哪一段下。它不是审美选择：三个成员共用一个域名，
  // 门户占着 `/`，两个控制台只能各让出一段（见 doc/deployment/nginx 里
  // `location ^~ /nova/` 与 `/orbit/`，那两条 proxy_pass 不改写路径，
  // 所以应用自己必须知道自己挂在哪）。
  nova: { name: 'Nova', role: 'provider', basePath: '/nova', home: '/provider/today', port: 17898 },
  orbit: { name: 'Orbit', role: 'consumer', basePath: '/orbit', home: '/consumer/keys', port: 17899 },
});

// 桌面壳默认加载哪个部署。它和上面的 basePath 是同一个地址的两半 ——
// 壳加载的是 defaultOrigin + basePath，也就是 https://www.galaxy.rodeo/nova
// 与 https://www.galaxy.rodeo/orbit（nginx 侧见 doc/deployment/nginx/
// www.galaxy.rodeo.conf 里 `location ^~ /nova/` 那两条）。
//
// 写在这里而不是抄进两个端的 main.ts：抄两份之后换域名只会改到一处，
// 而漏掉的那一端要等有人打开它才发现连的是老地方。
//
// 这是**兜底**，不是写死：启动时的 GALAXY_<端>_APP_ORIGIN / GALAXY_APP_ORIGIN
// 覆盖它，打包时的 APP_ORIGIN 会把值冻进安装包。优先级表见
// common/electron/origin.ts。
const defaultOrigin = 'https://www.galaxy.rodeo';

module.exports = { products, defaultOrigin };

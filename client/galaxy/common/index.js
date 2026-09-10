const products = Object.freeze({
  // home 是登录后的落点，也是外壳导航的第一项。Nova 的首页回答「现在在不在共享、
  // 今天赚了多少」，所以叫 today 而不是 overview —— 路由名和页面标题保持一致，
  // 免得日志里出现「用户停在 overview」而界面上根本没有这个词。
  nova: { name: 'Nova', role: 'provider', home: '/provider/today', port: 17898 },
  orbit: { name: 'Orbit', role: 'consumer', home: '/consumer/keys', port: 17899 },
});
module.exports = { products };

// 默认目标地址
const defaultUrl = 'https://dl.xianxintang.com/pc/lx-music-sourceV5.js';

export default {
  async fetch(request, env, ctx) {
    // 优先读取环境变量 env.geturl，不存在则使用默认值
    let targetUrl = env.geturl || defaultUrl;

    // 自动补齐协议前缀
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://${targetUrl}`;
    }

    // 302: 临时重定向 (适合以后可能频繁更换目标链接)
    // 301: 永久重定向 (浏览器会强缓存跳转结果)
    return Response.redirect(targetUrl, 302);
  },
};

// 默认目标 JS 地址
const defaultUrl = 'https://dl.xianxintang.com/pc/lx-music-sourceV5.js';

export default {
  async fetch(request, env, ctx) {
    // 优先读取环境变量 env.geturl，不存在则使用默认值
    let targetUrl = env.geturl || defaultUrl;

    // 自动补全协议前缀，防止因缺少 https:// 导致 fetch 报错
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      // 代理抓取目标 JS 文件
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Cloudflare-Worker',
        },
      });

      // 提取返回的内容与 Header，直接原样透传
      const body = await response.text();
      
      return new Response(body, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'application/javascript; charset=utf-8',
          'access-control-allow-origin': '*', // 允许跨域引用此 JS
          'cache-control': 'public, max-age=3600', // 设置缓存（可根据需要调整）
        },
      });
    } catch (err) {
      return new Response(`// Error fetching upstream: ${err.message}`, {
        status: 502,
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      });
    }
  },
};

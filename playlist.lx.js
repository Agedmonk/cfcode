//v0.0.2

const defaultUrl = 'https://dl.xianxintang.com/pc/lx-music-sourceV5.js';

export default {
  async fetch(request, env, ctx) {
    let targetUrl = env.geturl || defaultUrl;

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      // 构造请求头，避免源站拦截空 UA 或识别为爬虫
      const upstreamResponse = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
      });

      // 直接克隆响应体并添加 CORS 跨域头
      const newHeaders = new Headers(upstreamResponse.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Content-Type', upstreamResponse.headers.get('content-type') || 'application/javascript; charset=utf-8');

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: newHeaders,
      });
    } catch (err) {
      // 明确输出错误日志，避免直接抛出 520
      return new Response(`// Error loading script from upstream: ${err.message}`, {
        status: 502,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};

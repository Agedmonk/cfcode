// 默认目标网站
let pcUrl = 'www.zhaoqing.city';
let mobileUrl = 'www.zhaoqing.city';

const blocked_region = [];
const blocked_ip_address = [];

const replace_dict = {
  '$pcUrl': '$custom_domain',
  '//archiveofourown.org': ''
};

export default {
  async fetch(request, env, ctx) {
    try {
      pcUrl = env.URL_PC || pcUrl;
      mobileUrl = env.URL_MOBILE || mobileUrl;

      const region = (request.headers.get('cf-ipcountry') || '').toUpperCase();
      const ip_address = request.headers.get('cf-connecting-ip');
      const user_agent = request.headers.get('user-agent') || '';

      // 1. 黑名单直接拦截（拦截越早越省资源）
      if (blocked_region.includes(region)) {
        return new Response('Access denied: Region blocked.', { status: 403 });
      }
      if (blocked_ip_address.includes(ip_address)) {
        return new Response('Access denied: IP blocked.', { status: 403 });
      }

      let url = new URL(request.url);
      const url_host = url.host;

      // HTTP 自动重定向 HTTPS
      if (url.protocol === 'http:') {
        url.protocol = 'https:';
        return Response.redirect(url.href, 301);
      }

      // 区分移动端 / PC 端
      const isPc = device_status(user_agent);
      const pcUrl_domain = isPc ? pcUrl : mobileUrl;

      url.host = pcUrl_domain;

      let new_request_headers = new Headers(request.headers);
      new_request_headers.set('Host', pcUrl_domain);
      new_request_headers.set('Referer', url.href);

      // 2. 核心优化：利用 Cloudflare 边缘缓存，非 HTML 静态资源命中缓存不消耗 Worker 配额！
      const original_response = await fetch(url.href, {
        method: request.method,
        headers: new_request_headers,
        cf: {
          cacheEverything: true,      // 强制缓存所有静态文件
          cacheTtl: 86400,             // CDN 缓存 24 小时
          cacheTtlByStatus: { '200-299': 86400, '404': 30, '500-599': 0 }
        }
      });

      let response_headers = new Headers(original_response.headers);
      response_headers.set('cache-control', 'public, max-age=86400');
      response_headers.set('access-control-allow-origin', '*');
      response_headers.set('access-control-allow-credentials', 'true');
      response_headers.delete('content-security-policy');
      response_headers.delete('content-security-policy-report-only');
      response_headers.delete('clear-site-data');

      const content_type = response_headers.get('content-type') || '';

      // 3. 只有 HTML 页面才读取文本进行文本替换，其他二进制文件直接 Body 流式返回
      let body;
      if (content_type.includes('text/html')) {
        body = await replace_response_text(original_response, pcUrl_domain, url_host);
      } else {
        body = original_response.body;
      }

      return new Response(body, {
        status: original_response.status,
        headers: response_headers
      });

    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

async function replace_response_text(response, pcUrl_domain, host_name) {
  let text = await response.text();
  
  for (let i in replace_dict) {
    let targetKey = i === '$pcUrl' ? pcUrl_domain : (i === '$custom_domain' ? host_name : i);
    let replaceVal = replace_dict[i] === '$pcUrl' ? pcUrl_domain : (replace_dict[i] === '$custom_domain' ? host_name : replace_dict[i]);

    let re = new RegExp(targetKey, 'g');
    text = text.replace(re, replaceVal);
  }
  return text;
}

function device_status(user_agent_info) {
  const agents = ["Android", "iPhone", "SymbianOS", "Windows Phone", "iPad", "iPod"];
  return !agents.some(agent => user_agent_info.includes(agent));
}

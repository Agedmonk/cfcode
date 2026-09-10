export default {
  async fetch(request, env) {
    const originalUrl = new URL(request.url);
    
    // ==========================================
    // 防盗用授权逻辑
    // 1. 获取请求的路径（去掉开头的斜杠，方便比对，比如 "/NicholasLai" 变成 "NicholasLai"）
    const requestPath = originalUrl.pathname.substring(1);

    // 2. 将 ENV 密码和两个固定密码组合成一个允许通行的“白名单数组”
    const validPasswords = [
      env.PASSWORD, 
      "NicholasLai", 
      "226279dd-28b2-4b61-96be-a2a0b1afd522"
    ];

    const fallbackUrl = env.URL || "https://www.evergrande.com";

    // 3. 判断用户访问的路径，是否包含在我们的合法密码数组中
    if (validPasswords.includes(requestPath)) {
      return new Response("认证成功，正在跳转...", {
        status: 302,
        headers: {
          "Location": "/index.php",
          "Set-Cookie": `pages_proxy_auth=passed; Path=/; HttpOnly; Max-Age=3600`
        }
      });
    } });
    }

    const cookieHeader = request.headers.get("Cookie") || "";
    if (!cookieHeader.includes("pages_proxy_auth=passed")) {
      // 未授权不再显示 Access Denied，而是静默跳转到伪装页面
      return new Response("Redirecting...", {
        status: 302,
        headers: {
          "Location": fallbackUrl
        }
      });
    }
    // ==========================================
    // 拦截手机版/电脑版切换请求，直接由 Worker 下发对应 Cookie
    if (originalUrl.pathname.toLowerCase() === '/mobile.php') {
      // 兼容大写和原版小写参数
      const isMobParam = originalUrl.searchParams.get("ismobile") || originalUrl.searchParams.get("isMobile");
      
      if (isMobParam === "yes") {
        return new Response("Switching to Mobile View...", {
          status: 302,
          headers: {
            "Location": "/index.php",
            "Set-Cookie": "ismob=1; Path=/; Max-Age=31536000"
          }
        });
      } else if (isMobParam === "no") {
        return new Response("Switching to Desktop View...", {
          status: 302,
          headers: {
            "Location": "/index.php",
            "Set-Cookie": "ismob=0; Path=/; Max-Age=31536000"
          }
        });
      }
    }
    
    const targetHost = "www.t66y.com";
    const proxyUrl = new URL(request.url);
    proxyUrl.hostname = targetHost;
    
    const newRequest = new Request(proxyUrl, request);
    newRequest.headers.set("Host", targetHost);
    newRequest.headers.set("Referer", `https://${targetHost}/`);
    
    // 【关键修正1：隔离认证 Cookie】
    // 读取客户端原始 Cookie，并从中剔除 proxy 专用的身份验证 Cookie，防止污染目标服务器
    let clientCookies = request.headers.get("Cookie") || "";
    clientCookies = clientCookies.replace(/pages_proxy_auth=[^;]+;?\s*/g, "").trim();
    
    if (clientCookies) {
      newRequest.headers.set("Cookie", clientCookies);
    } else {
      newRequest.headers.delete("Cookie");
    }
    
    newRequest.headers.delete("Accept-Encoding");
    
    // 【关键修正2：拦截重定向】
    // 将 redirect 设为 manual，把服务端的 302 和 Set-Cookie 原封不动交回给浏览器处理
    const response = await fetch(newRequest, {
      cf: { cacheTtl: 0 },
      redirect: "manual" 
    });
    
    let body = response.body;
    const contentType = response.headers.get("Content-Type") || "";
    
    if (contentType.includes("text/html") || contentType.includes("application/javascript") || contentType.includes("text/javascript") || contentType.includes("text/css")) {
      let text = await response.text();
      text = text.replaceAll(`https://${targetHost}`, `https://${originalUrl.hostname}`);
      text = text.replaceAll(`http://${targetHost}`, `https://${originalUrl.hostname}`);
      text = text.replaceAll(targetHost, originalUrl.hostname);
      // 【关键修正3：全面替换裸域名】防止前端 JS 直接将 Cookie 写死在 t66y.com 域名上
      text = text.replaceAll("t66y.com", originalUrl.hostname);
      body = text;
    }
    
    // 【关键修正4：创建干净的 Headers】防止原有 response 直接传递时产生的格式错乱
    const newHeaders = new Headers(response.headers);
    
    if (typeof body === "string") {
      newHeaders.delete("Content-Length");
    }
    
    // 【关键修正5：逐条写入返回的 Cookie】防止 Cloudflare 逗号拼接导致浏览器拒收 Cookie
    newHeaders.delete("Set-Cookie");
    if (typeof response.headers.getSetCookie === "function") {
      const cookies = response.headers.getSetCookie();
      cookies.forEach(cookie => {
        // 抹除目标服务器试图绑定的原域名，让浏览器自动绑定当前访问的代理域名
        newHeaders.append("Set-Cookie", cookie.replace(/domain=[^;]+;?/gi, ""));
      });
    } else {
      for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase() === "set-cookie") {
          newHeaders.append("Set-Cookie", value.replace(/domain=[^;]+;?/gi, ""));
        }
      }
    }
    
    newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    newHeaders.set("Pragma", "no-cache");
    newHeaders.set("Expires", "0");
    
    // 【关键修正6：处理 Location 地址跳转】
    const location = newHeaders.get("Location");
    if (location) {
      let newLocation = location.replace(targetHost, originalUrl.hostname);
      newLocation = newLocation.replace("t66y.com", originalUrl.hostname);
      // 强制把目标可能返回的 http 跳转替换为 https，防止状态丢失
      newLocation = newLocation.replace("http://", "https://");
      newHeaders.set("Location", newLocation);
    }
    
    // 使用全新的 headers 返回给客户端
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};

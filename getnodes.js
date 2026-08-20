/**
 * 全球路由管理系统
 * 包含：登录验证、节点前端展示、节点后台管理、KV数据备份/恢复/导入/导出
 */

const DEFAULT_PASSWORD = 'NicholasLai';
const CONFIG_KEY = 'ROUTE_CONFIG';

// 初始默认配置（迁移自原有硬编码数据）
const DEFAULT_CONFIG = {
  groups: [
    {
      id: "g1", name: "日常连接", color: "pink", show: true,
      items: [
        { name: "电信网络", path: "niclai/chinatelecom", target: "https://chinatelecom.qingyuan.city/sub?token=fefd7730454a1d1bf4a89b3202de3c3d", show: true, enabled: true },
        { name: "移动网络", path: "niclai/cmcc", target: "https://cmcc.qingyuan.city/sub?token=df16f2c1fc47b0a4543b6c78cfe73224", show: true, enabled: true },
        { name: "工作网络", path: "niclai/huahailink", target: "https://huahailink.qingyuan.city/sub?token=5507dfd45861611c21c7a0a75d7eb6ec", show: true, enabled: true },
        { name: "家庭网络", path: "niclai/home", target: "https://home.qingyuan.city/sub?token=358d8b97e89b6219a60e384d31ccae9f", show: true, enabled: true },
        { name: "边缘网络", path: "edge/maoming.city", target: "https://edge.maoming.city/sub?token=8ce078439673804c0da42bb56b6a03e3", show: true, enabled: true },
        { name: "应急网络", path: "ss/zhaoqing.icu", target: "https://ss.zhaoqing.icu/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true }
      ]
    },
    {
      id: "g2", name: "隧道连接", color: "green", show: true,
      items: [
        { name: "个人机房", path: "edge/niclai.vip", target: "https://edge.niclai.vip/sub?token=102b3972db4ebfa502ec57efdb326578", show: true, enabled: true },
        { name: "肇庆机房", path: "edge/zhaoqing.city", target: "https://edge.zhaoqing.city/sub?token=b1b55f4fcde165fc88d36126e72ef6f7", show: true, enabled: true },
        { name: "清远机房", path: "edge/qingyuan.city", target: "https://edge.qingyuan.city/sub?token=30a0f2fb0782887ac7b619f64a595288", show: true, enabled: true },
        { name: "四会机房", path: "edge/sihui.city", target: "https://edge.sihui.city/sub?token=35e40796c83ae28dbd6ec9827d4a52b4", show: true, enabled: true },
        { name: "茂名机房", path: "edge/maoming.city", target: "https://edge.maoming.city/sub?token=8ce078439673804c0da42bb56b6a03e3", show: true, enabled: true },
        { name: "肇庆应急", path: "edge/zhaoqing.icu", target: "https://edge.zhaoqing.icu/sub?token=ee938efddaebde70ac91aea7e078cc12", show: true, enabled: true }
      ]
    },
    {
      id: "g3", name: "影子连接", color: "blue", show: true,
      items: [
        { name: "个人机房", path: "ss/niclai.vip", target: "https://ss.niclai.vip/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true },
        { name: "肇庆机房", path: "ss/zhaoqing.city", target: "https://ss.zhaoqing.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true },
        { name: "清远机房", path: "ss/qingyuan.city", target: "https://ss.qingyuan.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true },
        { name: "四会机房", path: "ss/sihui.city", target: "https://ss.sihui.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true },
        { name: "茂名机房", path: "ss/maoming.city", target: "https://ss.maoming.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true },
        { name: "肇庆应急", path: "ss/zhaoqing.icu", target: "https://ss.zhaoqing.icu/sub/226279dd-28b2-4b61-96be-a2a0b1afd522", show: true, enabled: true }
      ]
    },
    {
      id: "g4", name: "自由中国", color: "purple", show: true,
      items: [
        { name: "个人机房", path: "freechina/niclai.vip", target: "https://freechina.niclai.vip/226279dd-28b2-4b61-96be-a2a0b1afd522/sub", show: true, enabled: true },
        { name: "肇庆机房", path: "freechina/zhaoqing.city", target: "https://freechina.zhaoqing.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub", show: true, enabled: true },
        { name: "清远机房", path: "freechina/qingyuan.city", target: "https://freechina.qingyuan.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub", show: true, enabled: true },
        { name: "四会机房", path: "freechina/sihui.city", target: "https://freechina.sihui.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub", show: true, enabled: true },
        { name: "茂名机房", path: "freechina/maoming.city", target: "https://freechina.maoming.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub", show: true, enabled: true },
        { name: "肇庆应急", path: "freechina/zhaoqing.icu", target: "https://freechina.zhaoqing.icu/226279dd-28b2-4b61-96be-a2a0b1afd522/sub", show: true, enabled: true }
      ]
    },
    {
      id: "g5", name: "实时连接", color: "orange", show: true,
      items: [
        { name: "个人机房", path: "bpb/niclai.vip", target: "https://yun.niclai.vip/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw", show: true, enabled: true },
        { name: "肇庆机房", path: "bpb/zhaoqing.city", target: "https://yun.zhaoqing.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw", show: true, enabled: true },
        { name: "清远机房", path: "bpb/qingyuan.city", target: "https://yun.qingyuan.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw", show: true, enabled: true },
        { name: "四会机房", path: "bpb/sihui.city", target: "https://yun.sihui.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw", show: true, enabled: true },
        { name: "茂名机房", path: "bpb/maoming.city", target: "https://yun.maoming.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw", show: true, enabled: true },
        { name: "肇庆应急", path: "bpb/zhaoqing.icu", target: "https://yun.zhaoqing.icu/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw", show: true, enabled: true }
      ]
    }
  ]
};

// 潘通风格统一样式
const GLOBAL_STYLE = `
  :root { 
    --p-peach: #FFBE98; --p-magenta: #BE3455; --p-blue: #0f4c81; --p-gray: #f4f5f7;
    --text-main: #2c3e50; --text-light: #7f8c8d; --bg-main: #f8fafc; --card-bg: #ffffff;
    --border: #eaedf1; --shadow: 0 8px 24px rgba(0,0,0,0.04); --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: var(--bg-main); color: var(--text-main); -webkit-font-smoothing: antialiased; }
  .container { max-width: 750px; margin: 40px auto; padding: 0 15px; }
  .card { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px; }
  h2 { font-size: 22px; font-weight: 600; text-align: center; margin-bottom: 25px; color: var(--p-blue); letter-spacing: 0.5px; }
  button { border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
  button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  
  /* 颜色类 */
  .c-pink { background: #E8A7B3; color: #fff; }
  .c-green { background: #A3C9A8; color: #fff; }
  .c-blue { background: #84B4C8; color: #fff; }
  .c-purple { background: #B5A8C8; color: #fff; }
  .c-orange { background: #F3B584; color: #fff; }
  .c-red { background: #D98880; color: #fff; }
  .c-teal { background: #88C9C9; color: #fff; }
  .c-slate { background: #94A3B8; color: #fff; }
  
  .input-field { width: 100%; padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; outline: none; transition: 0.2s; background: #fafbfc; margin-bottom: 15px; }
  .input-field:focus { border-color: var(--p-blue); background: #fff; }
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const pwd = env.AUTH_PASSWORD || DEFAULT_PASSWORD;
    
    // 检查 KV 是否绑定
    if (!env.KV) {
      return new Response("未绑定 KV，请前往 Cloudflare 仪表板将 KV 命名空间绑定为变量名: KV", { status: 500 });
    }

    // 鉴权逻辑
    const cookies = request.headers.get("Cookie") || "";
    const isAuthed = cookies.includes(`route_auth=${pwd}`);

    // --- 路由: 登录与退出 ---
    if (path === "/login") {
      if (request.method === "POST") {
        const formData = await request.formData().catch(() => new FormData());
        if (formData.get("password") === pwd) {
          return new Response("OK", { status: 302, headers: { "Location": "/", "Set-Cookie": `route_auth=${pwd}; Path=/; HttpOnly; Max-Age=2592000` } });
        }
        return new Response(getLoginPage("密码错误，请重试"), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      return new Response(getLoginPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }
    if (path === "/logout") {
      return new Response("已退出", { status: 302, headers: { "Location": "/login", "Set-Cookie": "route_auth=; Path=/; HttpOnly; Max-Age=0" } });
    }

    // --- 权限拦截 ---
    const isProtected = ["/", "/admin"].includes(path) || path.startsWith("/api/");
    if (isProtected && !isAuthed) {
      if (path.startsWith("/api/")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      return Response.redirect(url.origin + '/login', 302);
    }

    // --- 获取并初始化配置 ---
    let configStr = await env.KV.get(CONFIG_KEY);
    let config = configStr ? JSON.parse(configStr) : DEFAULT_CONFIG;
    if (!configStr) await env.KV.put(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));

    // 生成扁平化映射（供代理和重定向使用）
    const flatMappings = {};
    config.groups.forEach(g => {
      if (g.items) g.items.forEach(i => { flatMappings[i.path] = i.target; });
    });

    // --- 路由: 前端页面 ---
    if (path === "/") {
      return new Response(getDisplayPage(config, url.hostname), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }
    if (path === "/admin") {
      return new Response(getAdminPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // --- 路由: API 数据操作 ---
    if (path === "/api/config") {
      if (request.method === "GET") return new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json" } });
      if (request.method === "POST") {
        const newConfig = await request.json();
        await env.KV.put(CONFIG_KEY, JSON.stringify(newConfig));
        return new Response(JSON.stringify({ success: true }));
      }
    }
    
    // --- 路由: 备份/恢复/导入/导出 ---
    if (path === "/api/backup") {
      if (request.method === "GET") {
        const list = await env.KV.list({ prefix: "backup_node_" });
        return new Response(JSON.stringify({ success: true, backups: list.keys.map(k => k.name) }));
      }
      if (request.method === "POST") {
        const d = new Date(); d.setTime(d.getTime() + 8 * 3600000); // UTC+8
        const pad = n => n.toString().padStart(2, '0');
        const key = `backup_node_${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
        await env.KV.put(key, JSON.stringify(config));
        return new Response(JSON.stringify({ success: true, key }));
      }
    }
    if (path === "/api/restore" && request.method === "POST") {
      const { key } = await request.json();
      const raw = await env.KV.get(key);
      if (raw) { await env.KV.put(CONFIG_KEY, raw); return new Response(JSON.stringify({ success: true })); }
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    if (path === "/api/export" && request.method === "GET") {
      return new Response(JSON.stringify(config, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="nodes_config.json"' }
      });
    }
    if (path === "/api/import" && request.method === "POST") {
      const data = await request.json();
      await env.KV.put(CONFIG_KEY, JSON.stringify(data));
      return new Response(JSON.stringify({ success: true }));
    }

    // --- 路由: 代理获取内容 ---
    if (path === "/proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl || !Object.values(flatMappings).includes(targetUrl)) return new Response("Forbidden", { status: 403 });
      try {
        const r = await fetch(targetUrl);
        return new Response(await r.text(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
      } catch (e) {
        return new Response("Proxy error", { status: 502 });
      }
    }

    // --- 路由: 最终重定向解析 ---
    let routeKey = path.replace(/^\/+|\/+$/g, '');
    const hostParts = url.hostname.split('.');
    const rootDomain = hostParts.length > 2 ? hostParts.slice(-2).join('.') : url.hostname;
    
    // 智能快捷补全
    if (['niclai', 'edge', 'station', 'ss', 'freechina', 'bpb'].includes(routeKey)) {
      routeKey = `${routeKey}/${rootDomain}`;
    }

    if (routeKey in flatMappings) {
      return Response.redirect(flatMappings[routeKey], 302);
    }

    // 默认回落
    return Response.redirect(`https://www.${rootDomain}`, 302);
  }
};

// ==================== 登录页 ====================
function getLoginPage(errorMsg = "") {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>全球路由管理系统 - 登录</title><style>${GLOBAL_STYLE}
    .login-container { max-width: 400px; margin: 10vh auto; }
    .logo-area { text-align: center; margin-bottom: 20px; color: var(--p-blue); }
    .btn-login { width: 100%; background: var(--p-blue); color: #fff; padding: 14px; font-size: 16px; border-radius: 8px; margin-top: 10px; }
    .error-msg { background: #FEF2F2; color: #DC2626; padding: 10px; border-radius: 8px; margin-bottom: 15px; text-align: center; font-size: 14px; border: 1px solid #FCA5A5; }
  </style></head><body>
  <div class="container login-container">
    <div class="card">
      <div class="logo-area">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <h2 style="margin-top: 10px; margin-bottom: 0;">全球路由管理系统</h2>
      </div>
      ${errorMsg ? `<div class="error-msg">${errorMsg}</div>` : ''}
      <form method="POST" action="/login">
        <input type="password" name="password" class="input-field" placeholder="请输入系统密码" required autofocus>
        <button type="submit" class="btn-login">安全登录</button>
      </form>
    </div>
  </div>
</body></html>`;
}

// ==================== 节点展示页 ====================
function getDisplayPage(config, domain) {
  // 仅渲染 show 为 true 的组和项
  let html = '';
  const frontendMappings = {};

  config.groups.filter(g => g.show).forEach(g => {
    html += `<div class="group-container">
      <div class="group-title"><span>${g.name}</span><svg class="arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></div>
      <div class="btn-grid">`;
    
    g.items.filter(i => i.show).forEach(i => {
      frontendMappings[i.path] = i.target;
      const dis = i.enabled ? '' : 'disabled="disabled"';
      html += `<button class="c-${g.color}" onclick="fetchData('${i.path}')" ${dis}>${i.name}</button>`;
    });
    
    html += `</div></div>`;
  });

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>全球机房 | ${domain}</title><style>${GLOBAL_STYLE}
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
    .group-container { border: 1px solid var(--border); margin-bottom: 15px; border-radius: var(--radius); background: #fff; overflow: hidden; }
    .group-title { font-size: 16px; font-weight: 600; color: var(--text-main); padding: 16px; background: #fafbfc; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
    .group-title:hover { background: #f1f2f6; }
    .group-title .arrow { transition: transform 0.3s ease; }
    .group-container.active .arrow { transform: rotate(180deg); }
    .btn-grid { display: none; padding: 15px; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; border-top: 1px solid var(--border); }
    .group-container.active .btn-grid { display: grid; }
    .btn-grid button { padding: 10px 5px; width: 100%; font-size: 13px; }
    
    .action-box { background: #f8fafc; border: 1px solid var(--border); border-radius: var(--radius); padding: 15px; margin-top: 20px; }
    .action-box button { width: 100%; padding: 12px; margin-bottom: 10px; background: var(--p-blue); color: #fff; }
    .data-box { background: #fff; padding: 12px; border-radius: 8px; border: 1px dashed #cbd5e1; font-size: 12px; word-break: break-all; min-height: 40px; color: var(--text-light); }
    
    #customAlert { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #10B981; color: white; padding: 12px 24px; border-radius: 30px; display: none; z-index: 1000; box-shadow: 0 4px 12px rgba(16,185,129,0.3); font-size: 14px; }
  </style></head><body>
  <div class="container">
    <div class="top-bar">
      <h2>全球机房节点</h2>
      <div>
        <a href="/admin" style="text-decoration:none; color:var(--text-light); font-size:14px; margin-right:15px;">⚙️ 后台管理</a>
        <a href="/logout" style="text-decoration:none; color:var(--p-magenta); font-size:14px;">🚪 退出</a>
      </div>
    </div>
    <div style="color: var(--text-light); margin-bottom: 20px; text-align: center; font-size: 14px;">当前访问域: ${domain}</div>
    
    ${html}
    
    <div class="action-box">
      <button onclick="copyContent('linkUrl', '订阅地址已复制')">复制当前节点订阅链接</button>
      <div class="data-box" id="linkUrl">点击任意可用节点获取订阅链接...</div>
    </div>
    <div class="action-box">
      <button onclick="copyContent('sourceUrl', '实际地址已复制')">复制当前节点实际地址</button>
      <div class="data-box" id="sourceUrl">点击任意可用节点获取真实地址...</div>
    </div>
    <div class="action-box">
      <button onclick="copyContent('output', '节点内容已复制')">复制当前节点具体内容</button>
      <div class="data-box" id="output" style="white-space:pre-wrap; min-height:80px;">点击任意可用节点获取内容...</div>
    </div>
  </div>
  <div id="customAlert"></div>

  <script>
    const MAPPINGS = ${JSON.stringify(frontendMappings)};
    
    document.querySelectorAll('.group-title').forEach(el => {
      el.addEventListener('click', () => el.parentElement.classList.toggle('active'));
    });

    async function fetchData(path) {
      const o = document.getElementById('output');
      const linkBox = document.getElementById('linkUrl');
      const sourceBox = document.getElementById('sourceUrl');

      const subUrl = window.location.origin + '/' + path;
      linkBox.textContent = subUrl;
      const realUrl = MAPPINGS[path];
      sourceBox.textContent = realUrl || "未在配置中找到此链接";
      o.textContent = "内容拉取中...";

      if (!realUrl) return;
      try {
        const proxyUrl = window.location.origin + '/proxy?url=' + encodeURIComponent(realUrl);
        const r = await fetch(proxyUrl);
        if (!r.ok) { o.textContent = "请求失败，状态码: " + r.status; return; }
        o.textContent = await r.text();
      } catch(e) {
        o.textContent = "拉取失败，请检查网络或配置";
      }
    }

    function copyContent(id, msg) {
      const text = document.getElementById(id).textContent;
      if (!text || text.includes('点击') || text.includes('拉取中')) return;
      navigator.clipboard.writeText(text).then(() => {
        const alertBox = document.getElementById('customAlert');
        alertBox.textContent = msg; alertBox.style.display = 'block';
        setTimeout(() => alertBox.style.display = 'none', 2000);
      });
    }
  </script>
</body></html>`;
}

// ==================== 节点管理页 ====================
function getAdminPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>节点管理后台</title><style>${GLOBAL_STYLE}
    .top-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 25px; padding: 15px; background: #fff; border-radius: 8px; border: 1px solid var(--border); }
    .top-actions button { flex: 1; min-width: 100px; padding: 10px; font-size: 13px; }
    .btn-green { background: #10B981; color: #fff; } .btn-orange { background: #F59E0B; color: #fff; }
    .btn-purple { background: #8B5CF6; color: #fff; } .btn-blue { background: #3B82F6; color: #fff; }
    
    .group-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
    .g-header { background: #f8fafc; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); }
    .g-header input[type="text"] { border: 1px solid #cbd5e1; padding: 6px; border-radius: 4px; font-size: 14px; width: 120px; }
    .g-header select { padding: 6px; border: 1px solid #cbd5e1; border-radius: 4px; }
    .icon-btn { background: transparent; border: none; font-size: 16px; cursor: pointer; padding: 4px; color: #64748b; }
    .icon-btn:hover { color: var(--p-blue); }
    
    .item-row { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 15px; border-bottom: 1px solid #f1f2f6; align-items: center; }
    .item-row:last-child { border-bottom: none; }
    .item-row input[type="text"] { flex: 1; min-width: 100px; padding: 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; }
    .item-row .target-input { flex: 2; min-width: 150px; }
    .item-actions { display: flex; gap: 8px; align-items: center; }
    .add-btn { width: 100%; background: #f8fafc; border: 1px dashed #cbd5e1; padding: 10px; color: #64748b; }
    .add-btn:hover { background: #f1f5f9; color: var(--p-blue); }
    
    .save-bar { position: sticky; bottom: 20px; background: rgba(255,255,255,0.9); backdrop-filter: blur(5px); padding: 15px; border-radius: 12px; box-shadow: 0 -4px 15px rgba(0,0,0,0.05); border: 1px solid var(--border); display: flex; justify-content: center; z-index: 100; }
    .save-bar button { width: 50%; padding: 12px; background: var(--p-blue); color: #fff; font-size: 16px; border-radius: 30px; }
    
    /* 模态框 */
    .modal { display: none; position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); align-items: center; justify-content: center; z-index: 200; }
    .modal.active { display: flex; }
    .modal-content { background: #fff; padding: 25px; border-radius: 12px; width: 300px; text-align: center; }
  </style></head><body>
  <div class="container" style="max-width: 900px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h2>⚙️ 节点管理后台</h2>
      <a href="/" style="text-decoration:none; color:var(--text-light); font-size:14px;">🏠 返回前台</a>
    </div>

    <!-- 顶部数据管理组件 -->
    <div class="top-actions">
      <button class="btn-green" onclick="doBackup()">💾 备份当前配置</button>
      <button class="btn-orange" onclick="showRestore()">⏪ 恢复历史配置</button>
      <button class="btn-purple" onclick="doExport()">📤 导出配置JSON</button>
      <button class="btn-blue" onclick="document.getElementById('importFile').click()">📥 导入配置JSON</button>
      <input type="file" id="importFile" accept=".json" style="display:none" onchange="doImport(event)">
    </div>

    <div id="editorContainer"></div>
    
    <button class="add-btn" style="border-style:solid; margin-top:10px; border-radius:8px;" onclick="addGroup()">➕ 添加新分组</button>

    <div class="save-bar">
      <button onclick="saveConfig()">保存全部修改</button>
    </div>
  </div>

  <div id="restoreModal" class="modal">
    <div class="modal-content">
      <h3 style="margin-bottom:15px; font-size:16px;">选择备份文件</h3>
      <select id="backupSelect" style="width:100%; padding:8px; margin-bottom:15px;"></select>
      <div style="display:flex; gap:10px;">
        <button style="flex:1; padding:8px; background:#F59E0B; color:#fff;" onclick="confirmRestore()">恢复</button>
        <button style="flex:1; padding:8px; background:#e2e8f0; color:#475569;" onclick="document.getElementById('restoreModal').classList.remove('active')">取消</button>
      </div>
    </div>
  </div>

  <script>
    let configData = { groups: [] };
    const COLORS = ['pink','green','blue','purple','orange','red','teal','slate'];

    async function loadData() {
      const res = await fetch('/api/config');
      configData = await res.json();
      render();
    }

    function render() {
      const container = document.getElementById('editorContainer');
      container.innerHTML = '';
      
      configData.groups.forEach((g, gIdx) => {
        const div = document.createElement('div');
        div.className = 'group-card';
        
        let colorOpts = COLORS.map(c => \`<option value="\${c}" \${g.color===c?'selected':''}>\${c}</option>\`).join('');
        
        let html = \`<div class="g-header">
          <div style="display:flex; gap:10px; align-items:center;">
            <input type="text" value="\${g.name}" onchange="updateG(\${gIdx}, 'name', this.value)" placeholder="分组名">
            <select onchange="updateG(\${gIdx}, 'color', this.value)">\${colorOpts}</select>
            <label style="font-size:13px; cursor:pointer;"><input type="checkbox" \${g.show?'checked':''} onchange="updateG(\${gIdx}, 'show', this.checked)"> 显示</label>
          </div>
          <div>
            <button class="icon-btn" onclick="moveG(\${gIdx}, -1)" title="上移">⬆️</button>
            <button class="icon-btn" onclick="moveG(\${gIdx}, 1)" title="下移">⬇️</button>
            <button class="icon-btn" onclick="delG(\${gIdx})" title="删除" style="color:#ef4444">✖️</button>
          </div>
        </div><div class="g-body">\`;
        
        g.items.forEach((item, iIdx) => {
          html += \`<div class="item-row">
            <input type="text" placeholder="展示名" value="\${item.name}" onchange="updateI(\${gIdx},\${iIdx},'name',this.value)">
            <input type="text" placeholder="路由路径(key)" value="\${item.path}" onchange="updateI(\${gIdx},\${iIdx},'path',this.value)">
            <input type="text" class="target-input" placeholder="指向地址(真实链接)" value="\${item.target}" onchange="updateI(\${gIdx},\${iIdx},'target',this.value)">
            <div class="item-actions">
              <label style="font-size:12px;"><input type="checkbox" \${item.show?'checked':''} onchange="updateI(\${gIdx},\${iIdx},'show',this.checked)"> 显示</label>
              <label style="font-size:12px;"><input type="checkbox" \${item.enabled?'checked':''} onchange="updateI(\${gIdx},\${iIdx},'enabled',this.checked)"> 启用</label>
              <button class="icon-btn" onclick="moveI(\${gIdx}, \${iIdx}, -1)">⬆️</button>
              <button class="icon-btn" onclick="moveI(\${gIdx}, \${iIdx}, 1)">⬇️</button>
              <button class="icon-btn" onclick="delI(\${gIdx}, \${iIdx})" style="color:#ef4444">✖️</button>
            </div>
          </div>\`;
        });
        
        html += \`<button class="add-btn" onclick="addI(\${gIdx})">➕ 添加条目</button></div>\`;
        div.innerHTML = html;
        container.appendChild(div);
      });
    }

    // 数据操作函数
    const updateG = (g, k, v) => configData.groups[g][k] = v;
    const updateI = (g, i, k, v) => configData.groups[g].items[i][k] = v;
    const swap = (arr, i, j) => { if(j>=0 && j<arr.length) [arr[i], arr[j]] = [arr[j], arr[i]]; };
    const moveG = (g, d) => { swap(configData.groups, g, g+d); render(); };
    const moveI = (g, i, d) => { swap(configData.groups[g].items, i, i+d); render(); };
    const delG = (g) => { if(confirm('确认删除此分组？')) { configData.groups.splice(g, 1); render(); } };
    const delI = (g, i) => { configData.groups[g].items.splice(i, 1); render(); };
    const addG = () => { configData.groups.push({ id:'g'+Date.now(), name:'新分组', color:'blue', show:true, items:[] }); render(); };
    const addI = (g) => { configData.groups[g].items.push({ name:'', path:'', target:'', show:true, enabled:true }); render(); };

    async function saveConfig() {
      const btn = document.querySelector('.save-bar button');
      btn.textContent = '保存中...'; btn.disabled = true;
      const res = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(configData) });
      const r = await res.json();
      btn.textContent = r.success ? '保存成功！' : '保存失败';
      setTimeout(() => { btn.textContent = '保存全部修改'; btn.disabled = false; }, 2000);
    }

    // KV 备份与恢复功能
    async function doBackup() {
      if(!confirm('备份当前数据？')) return;
      const r = await (await fetch('/api/backup', { method:'POST' })).json();
      alert(r.success ? '✅ 备份成功：' + r.key : '❌ 备份失败');
    }
    async function showRestore() {
      const r = await (await fetch('/api/backup')).json();
      if(!r.success || !r.backups.length) return alert('无可用备份文件');
      const sel = document.getElementById('backupSelect'); sel.innerHTML = '';
      r.backups.sort().reverse().forEach(b => sel.appendChild(new Option(b, b)));
      document.getElementById('restoreModal').classList.add('active');
    }
    async function confirmRestore() {
      const key = document.getElementById('backupSelect').value;
      if(!confirm('恢复将覆盖当前数据，确认？')) return;
      const r = await (await fetch('/api/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key}) })).json();
      if(r.success) { alert('✅ 恢复成功'); window.location.reload(); }
    }
    function doExport() { window.location.href = '/api/export'; }
    function doImport(e) {
      const file = e.target.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const json = JSON.parse(ev.target.result);
          if(!confirm('导入将覆盖当前配置，确认？')) return;
          const r = await (await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(json) })).json();
          if(r.success) { alert('✅ 导入成功'); window.location.reload(); }
        } catch(err) { alert('❌ JSON 格式错误'); }
        e.target.value = '';
      };
      reader.readAsText(file);
    }

    loadData();
  </script>
</body></html>`;
}

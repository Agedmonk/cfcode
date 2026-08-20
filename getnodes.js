/**
 * 全球路由管理系统
 * 包含：登录验证、多彩节点展示、可折叠节点后台管理、KV数据备份/恢复/导入/导出
 */

const DEFAULT_PASSWORD = 'NicholasLai';
const CONFIG_KEY = 'ROUTE_CONFIG';

// 初始默认配置
const DEFAULT_CONFIG = {
  groups: [
    {
      id: "g1", name: "日常连接", color: 29, show: true,
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
      id: "g2", name: "隧道连接", color: 13, show: true,
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
      id: "g3", name: "影子连接", color: 14, show: true,
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
      id: "g4", name: "自由中国", color: 30, show: true,
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
      id: "g5", name: "实时连接", color: 20, show: true,
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

// 32种潘通色 CSS生成
const generateColors = () => {
  const hex = [
    '#F94144', '#F3722C', '#F8961E', '#F9844A', '#F9C74F', '#90BE6D', '#43AA8B', '#4D908E',
    '#577590', '#277DA1', '#EF476F', '#FFD166', '#06D6A0', '#118AB2', '#073B4C', '#8ECAE6',
    '#219EBC', '#023047', '#FFB703', '#FB8500', '#E63946', '#B5838D', '#E5989B', '#457B9D',
    '#1D3557', '#D90429', '#8D99AE', '#2B2D42', '#F72585', '#7209B7', '#3A0CA3', '#4361EE'
  ];
  const lightIndexes = [5, 12, 16, 23];
  return hex.map((h, i) => `.c-${i+1} { background-color: ${h} !important; color: ${lightIndexes.includes(i+1) ? '#1E293B' : '#FFFFFF'} !important; }`).join('');
};

const GLOBAL_STYLE = `
  :root { 
    --p-blue: #0f4c81; --p-magenta: #BE3455; 
    --text-main: #2c3e50; --text-light: #7f8c8d; --bg-main: #F4F7F9; --card-bg: #ffffff;
    --border: #eaedf1; --shadow: 0 8px 30px rgba(0,0,0,0.06); --radius: 14px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-main); background-image: linear-gradient(135deg, #fdfbfb 0%, #f4f7f9 100%); color: var(--text-main); -webkit-font-smoothing: antialiased; min-height: 100vh; }
  .container { max-width: 800px; margin: 40px auto; padding: 0 15px; }
  .card { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px; border: 1px solid rgba(255,255,255,0.6); }
  
  .top-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; gap: 15px; flex-wrap: wrap; }
  @media (max-width: 500px) { .top-header { justify-content: center; flex-direction: column; text-align: center; } }
  .top-header h2 { margin: 0; font-size: 22px; font-weight: 600; color: var(--p-blue); letter-spacing: 0.5px; }
  .top-btn { text-decoration: none; font-size: 14px; font-weight: 500; background: #fff; padding: 8px 18px; border-radius: 20px; box-shadow: var(--shadow); color: var(--text-main); transition: 0.2s; border: 1px solid var(--border); display: inline-flex; align-items: center; justify-content: center; }
  .top-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 15px rgba(0,0,0,0.1); }

  button { border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; min-height: 40px; }
  button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); filter: brightness(1.05); }
  button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; filter: grayscale(1); }
  
  .input-field { width: 100%; padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; outline: none; transition: 0.2s; background: #fafbfc; margin-bottom: 15px; }
  .input-field:focus { border-color: var(--p-blue); background: #fff; box-shadow: 0 0 0 3px rgba(15,76,129,0.1); }
  
  ${generateColors()}
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const pwd = env.AUTH_PASSWORD || DEFAULT_PASSWORD;
    
    if (!env.KV) return new Response("Error: KV namespace 'KV' not bound.", { status: 500 });

    const cookies = request.headers.get("Cookie") || "";
    const isAuthed = cookies.includes(`route_auth=${pwd}`);

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

    if (["/", "/admin"].includes(path) || path.startsWith("/api/")) {
      if (!isAuthed) {
        if (path.startsWith("/api/")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        return Response.redirect(url.origin + '/login', 302);
      }
    }

    let configStr = await env.KV.get(CONFIG_KEY);
    let config = configStr ? JSON.parse(configStr) : DEFAULT_CONFIG;
    if (!configStr) await env.KV.put(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));

    const flatMappings = {};
    config.groups.forEach(g => {
      if (g.items) g.items.forEach(i => { flatMappings[i.path] = i.target; });
    });

    if (path === "/") return new Response(getDisplayPage(config, url.hostname), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (path === "/admin") return new Response(getAdminPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    if (path === "/api/config") {
      if (request.method === "GET") return new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json" } });
      if (request.method === "POST") {
        await env.KV.put(CONFIG_KEY, JSON.stringify(await request.json()));
        return new Response(JSON.stringify({ success: true }));
      }
    }
    
    if (path === "/api/backup") {
      if (request.method === "GET") {
        const list = await env.KV.list({ prefix: "backup_node_" });
        return new Response(JSON.stringify({ success: true, backups: list.keys.map(k => k.name) }));
      }
      if (request.method === "POST") {
        const d = new Date(Date.now() + 8 * 3600000); // UTC+8
        const pad = n => n.toString().padStart(2, '0');
        const key = `backup_node_${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
        await env.KV.put(key, JSON.stringify(config));
        return new Response(JSON.stringify({ success: true, key }));
      }
    }
    if (path === "/api/restore" && request.method === "POST") {
      const raw = await env.KV.get((await request.json()).key);
      if (raw) { await env.KV.put(CONFIG_KEY, raw); return new Response(JSON.stringify({ success: true })); }
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    if (path === "/api/export") {
      return new Response(JSON.stringify(config, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="nodes_config.json"' } });
    }
    if (path === "/api/import" && request.method === "POST") {
      await env.KV.put(CONFIG_KEY, JSON.stringify(await request.json()));
      return new Response(JSON.stringify({ success: true }));
    }

    if (path === "/proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl || !Object.values(flatMappings).includes(targetUrl)) return new Response("Forbidden", { status: 403 });
      try {
        const r = await fetch(targetUrl);
        return new Response(await r.text(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
      } catch (e) { return new Response("Proxy error", { status: 502 }); }
    }

    let routeKey = path.replace(/^\/+|\/+$/g, '');
    const hostParts = url.hostname.split('.');
    const rootDomain = hostParts.length > 2 ? hostParts.slice(-2).join('.') : url.hostname;
    
    if (['niclai', 'edge', 'station', 'ss', 'freechina', 'bpb'].includes(routeKey)) routeKey = `${routeKey}/${rootDomain}`;
    if (routeKey in flatMappings) return Response.redirect(flatMappings[routeKey], 302);
    return Response.redirect(`https://www.${rootDomain}`, 302);
  }
};

// ==================== 登录页 ====================
function getLoginPage(errorMsg = "") {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>全球路由 - 登录</title><style>${GLOBAL_STYLE}
    .login-container { max-width: 380px; margin: 15vh auto; }
    .logo-area { text-align: center; margin-bottom: 25px; color: var(--p-blue); }
    .btn-login { width: 100%; background: var(--p-blue); color: #fff; padding: 14px; font-size: 16px; margin-top: 10px; }
    .error-msg { background: #FEF2F2; color: #DC2626; padding: 12px; border-radius: 8px; margin-bottom: 15px; text-align: center; font-size: 14px; border: 1px solid #FCA5A5; }
  </style></head><body>
  <div class="container login-container">
    <div class="card">
      <div class="logo-area">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <h2 style="margin-top: 15px; margin-bottom: 0;">全球路由管理系统</h2>
      </div>
      ${errorMsg ? `<div class="error-msg">${errorMsg}</div>` : ''}
      <form method="POST" action="/login">
        <input type="password" name="password" class="input-field" placeholder="请输入系统密码" required autofocus>
        <button type="submit" class="btn-login">安 全 登 录</button>
      </form>
    </div>
  </div>
</body></html>`;
}

// ==================== 节点展示页 ====================
function getDisplayPage(config, domain) {
  let html = '';
  const frontendMappings = {};

  config.groups.filter(g => g.show).forEach(g => {
    html += `<div class="group-container ${g._expanded !== false ? 'active' : ''}">
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
    .group-container { border: 1px solid var(--border); margin-bottom: 16px; border-radius: var(--radius); background: #fff; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.02); transition: all 0.3s; }
    .group-title { font-size: 16px; font-weight: 600; padding: 16px 20px; background: #fafbfc; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; }
    .group-title:hover { background: #f1f2f6; }
    .group-title .arrow { transition: transform 0.3s ease; color: #94A3B8; }
    .group-container.active .arrow { transform: rotate(180deg); }
    .btn-grid { display: none; padding: 20px; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 12px; border-top: 1px solid var(--border); }
    .group-container.active .btn-grid { display: grid; }
    .btn-grid button { width: 100%; padding: 12px 8px; font-size: 14px; letter-spacing: 0.5px; border-radius: 10px; }
    
    .action-box { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-top: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
    .action-box button { width: 100%; padding: 14px; margin-bottom: 12px; background: var(--p-blue); color: #fff; font-size: 15px; border-radius: 10px; }
    .data-box { background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px dashed #cbd5e1; font-size: 13px; word-break: break-all; min-height: 48px; color: var(--text-light); line-height: 1.5; }
    
    #customAlert { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #10B981; color: white; padding: 12px 24px; border-radius: 30px; display: none; z-index: 1000; box-shadow: 0 4px 12px rgba(16,185,129,0.3); font-size: 14px; }
  </style></head><body>
  <div class="container">
    <div class="top-header">
      <h2>🌍 全球机房节点</h2>
      <div style="display: flex; gap: 10px; justify-content: center;">
        <a href="/admin" class="top-btn">⚙️ 后台管理</a>
        <a href="/logout" class="top-btn" style="color:var(--p-magenta)">🚪 退出</a>
      </div>
    </div>
    
    <div style="color: var(--text-light); margin-bottom: 25px; text-align: center; font-size: 14px; background: #fff; padding: 10px; border-radius: 30px; border: 1px solid var(--border); display: inline-block; width: 100%;">当前域: <b>${domain}</b></div>
    
    ${html}
    
    <div class="action-box">
      <button onclick="copyContent('linkUrl', '订阅地址已复制')">🔗 复制当前节点订阅链接</button>
      <div class="data-box" id="linkUrl">点击上方任意可用节点...</div>
    </div>
    <div class="action-box">
      <button onclick="copyContent('sourceUrl', '实际地址已复制')" style="background:#475569">🎯 复制当前节点实际地址</button>
      <div class="data-box" id="sourceUrl">等待选择节点...</div>
    </div>
    <div class="action-box">
      <button onclick="copyContent('output', '节点内容已复制')" style="background:#10B981">📄 复制当前节点具体内容</button>
      <div class="data-box" id="output" style="white-space:pre-wrap; min-height:100px;">等待选择节点...</div>
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
      o.textContent = "内容高速拉取中...";

      if (!realUrl) return;
      try {
        const r = await fetch(window.location.origin + '/proxy?url=' + encodeURIComponent(realUrl));
        if (!r.ok) { o.textContent = "请求失败，状态码: " + r.status; return; }
        o.textContent = await r.text();
      } catch(e) { o.textContent = "拉取失败，请检查网络或配置"; }
    }

    function copyContent(id, msg) {
      const text = document.getElementById(id).textContent;
      if (!text || text.includes('点击') || text.includes('拉取中') || text.includes('等待')) return;
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
    .top-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 25px; background: #fff; padding: 15px; border-radius: var(--radius); box-shadow: var(--shadow); }
    .top-actions button { width: 100%; padding: 12px; font-size: 14px; }
    .btn-green { background: #10B981; color: #fff; } .btn-orange { background: #F59E0B; color: #fff; }
    .btn-purple { background: #8B5CF6; color: #fff; } .btn-blue { background: #3B82F6; color: #fff; }
    
    .group-card { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 20px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
    .g-header { background: #fafbfc; padding: 15px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); cursor: pointer; user-select: none; transition: background 0.2s; }
    .g-header:hover { background: #f1f2f6; }
    .g-header-left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 250px; }
    .g-header-right { display: flex; align-items: center; gap: 10px; }
    .g-header input[type="text"] { border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 8px; font-size: 14px; flex: 1; max-width: 180px; }
    
    .g-body { display: none; padding-bottom: 10px; }
    .group-card.expanded .g-body { display: block; }
    .group-card.expanded .arrow-btn svg { transform: rotate(180deg); }
    
    .icon-btn { background: #f1f5f9; color: #475569; width: 36px; height: 36px; border-radius: 8px; font-size: 16px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #e2e8f0; transition: all 0.2s; }
    .icon-btn:hover { background: #e2e8f0; color: var(--p-blue); border-color: #cbd5e1; }
    
    .color-picker { position: relative; }
    .current-color { width: 36px; height: 36px; border-radius: 8px; cursor: pointer; border: 2px solid #fff; box-shadow: 0 0 0 1px var(--border); }
    .picker-grid { display: none; position: absolute; top: 45px; left: 0; width: 270px; background: #fff; border: 1px solid var(--border); padding: 12px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); flex-wrap: wrap; gap: 6px; z-index: 50; }
    .picker-grid { display: none !important; }
    .picker-grid.active { display: flex !important; }
    
    @media(max-width: 350px) { .picker-grid { left: -10px; width: 240px; } }
    .color-swatch { width: 30px; height: 30px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(0,0,0,0.05); transition: 0.2s; }
    .color-swatch:hover { transform: scale(1.1); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
    
    .item-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 15px; border-bottom: 1px solid #f1f2f6; align-items: center; }
    .item-row input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
    .item-row .target-input { grid-column: 1 / -1; }
    @media(min-width: 800px) { .item-row { grid-template-columns: 1fr 1.5fr 2.5fr auto; } .item-row .target-input { grid-column: auto; } }
    
    /* 重点修正：让复选框与按钮区域全部在一行展示，绝不换行 */
    .item-actions { display: flex; gap: 10px; align-items: center; justify-content: flex-end; padding-left: 5px; flex-wrap: nowrap; white-space: nowrap; }
    
    .add-btn { width: calc(100% - 30px); margin: 5px 15px 15px; background: #f8fafc; border: 2px dashed #cbd5e1; padding: 12px; color: #64748b; font-size: 14px; border-radius: 10px; }
    .add-btn:hover { background: #f1f5f9; color: var(--p-blue); border-color: #94a3b8; }
    
    .save-bar { position: sticky; bottom: 20px; background: rgba(255,255,255,0.85); backdrop-filter: blur(10px); padding: 15px; border-radius: 100px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.5); display: flex; justify-content: center; z-index: 100; max-width: 400px; margin: 0 auto; }
    .save-bar button { width: 100%; padding: 14px; background: var(--p-blue); color: #fff; font-size: 16px; border-radius: 50px; }
    
    .modal { display: none; position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.6); align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(2px); }
    .modal.active { display: flex; }
    .modal-content { background: #fff; padding: 30px; border-radius: var(--radius); width: 90%; max-width: 400px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
  </style></head><body>
  <div class="container" style="max-width: 1000px; padding-bottom: 100px;">
    
    <div class="top-header">
      <h2>⚙️ 节点配置管理后台</h2>
      <div style="display: flex; gap: 10px; justify-content: center;">
        <a href="/" class="top-btn">🏠 返回前台</a>
      </div>
    </div>

    <div class="top-actions">
      <button class="btn-green" onclick="doBackup()">💾 备份到云端</button>
      <button class="btn-orange" onclick="showRestore()">⏪ 恢复历史配置</button>
      <button class="btn-purple" onclick="doExport()">📤 导出 JSON 文件</button>
      <button class="btn-blue" onclick="document.getElementById('importFile').click()">📥 导入 JSON 文件</button>
      <input type="file" id="importFile" accept=".json" style="display:none" onchange="doImport(event)">
    </div>

    <div id="editorContainer"></div>
    <button class="add-btn" style="width: 100%; margin: 10px 0;" onclick="addG()">➕ 添加新节点分组</button>

    <div class="save-bar">
      <button id="btnSaveConfig" onclick="saveConfig()">🚀 保存所有更改</button>
    </div>
  </div>

  <div id="restoreModal" class="modal">
    <div class="modal-content">
      <h3 style="margin-bottom:20px; font-size:18px; color:var(--p-blue);">⏪ 选择备份进行恢复</h3>
      <select id="backupSelect" style="width:100%; padding:12px; margin-bottom:20px; border:1px solid var(--border); border-radius:8px; outline:none;"></select>
      <div style="display:flex; gap:10px;">
        <button style="flex:1; background:#F59E0B; color:#fff;" onclick="confirmRestore()">确认恢复</button>
        <button style="flex:1; background:#f1f5f9; color:#475569;" onclick="document.getElementById('restoreModal').classList.remove('active')">取消</button>
      </div>
    </div>
  </div>

  <script>
    const ICONS = ${JSON.stringify({
      up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
      down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
      edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
      del: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    })};

    let configData = { groups: [] };
    
    document.addEventListener('click', e => {
      if(!e.target.closest('.color-picker')) {
        document.querySelectorAll('.picker-grid').forEach(el => el.classList.remove('active'));
      }
    });

    async function loadData() {
      const res = await fetch('/api/config');
      configData = await res.json();
      configData.groups.forEach(g => {
         g._expanded = false; 
      });
      render();
    }

    function render() {
      const container = document.getElementById('editorContainer');
      container.innerHTML = '';
      
      configData.groups.forEach((g, gIdx) => {
        let colorGrid = '';
        for(let c=1; c<=32; c++) {
          colorGrid += \`<div class="color-swatch c-\${c}" onclick="updateColor(\${gIdx}, \${c})"></div>\`;
        }

        const div = document.createElement('div');
        div.className = \`group-card \${g._expanded ? 'expanded' : ''}\`;
        div.dataset.index = gIdx; 
        
        let html = \`
        <div class="g-header" onclick="toggleCard(this, event)">
          <div class="g-header-left">
            <button class="icon-btn arrow-btn" style="border:none;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition:0.3s;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="color-picker">
              <div class="current-color c-\${g.color}" onclick="togglePicker(\${gIdx}, event)"></div>
              <div class="picker-grid" id="picker-\${gIdx}">\${colorGrid}</div>
            </div>
            <input type="text" value="\${g.name}" onchange="updateG(\${gIdx}, 'name', this.value)" placeholder="分组名">
          </div>
          <div class="g-header-right">
            <label style="font-size:14px; cursor:pointer; display:flex; align-items:center; gap:5px; margin-right:5px;">
              <input type="checkbox" style="transform:scale(1.2);" \${g.show?'checked':''} onchange="updateG(\${gIdx}, 'show', this.checked)"> 显示
            </label>
            <button class="icon-btn" onclick="moveG(\${gIdx}, -1, event)" title="上移">\${ICONS.up}</button>
            <button class="icon-btn" onclick="moveG(\${gIdx}, 1, event)" title="下移">\${ICONS.down}</button>
            <button class="icon-btn" onclick="delG(\${gIdx}, event)" title="删除" style="color:#EF4444; border-color:#FCA5A5; background:#FEF2F2;">\${ICONS.del}</button>
          </div>
        </div>
        <div class="g-body">\`;
        
        g.items.forEach((item, iIdx) => {
          html += \`
          <div class="item-row">
            <input type="text" placeholder="展示名" value="\${item.name}" onchange="updateI(\${gIdx},\${iIdx},'name',this.value)">
            <input type="text" placeholder="路由路径" value="\${item.path}" onchange="updateI(\${gIdx},\${iIdx},'path',this.value)">
            <input type="text" class="target-input" placeholder="指向地址(真实链接)" value="\${item.target}" onchange="updateI(\${gIdx},\${iIdx},'target',this.value)">
            <div class="item-actions">
              <label style="font-size:14px; display:flex; align-items:center; gap:4px; cursor:pointer; margin:0;"><input type="checkbox" style="transform:scale(1.1); margin:0;" \${item.show?'checked':''} onchange="updateI(\${gIdx},\${iIdx},'show',this.checked)">显示</label>
              <label style="font-size:14px; display:flex; align-items:center; gap:4px; cursor:pointer; margin:0;"><input type="checkbox" style="transform:scale(1.1); margin:0;" \${item.enabled?'checked':''} onchange="updateI(\${gIdx},\${iIdx},'enabled',this.checked)">启用</label>
              <button class="icon-btn" style="margin-left:4px;" onclick="moveI(\${gIdx}, \${iIdx}, -1)" title="上移">\${ICONS.up}</button>
              <button class="icon-btn" onclick="moveI(\${gIdx}, \${iIdx}, 1)" title="下移">\${ICONS.down}</button>
              <button class="icon-btn" style="color:#EF4444; border-color:#FCA5A5; background:#FEF2F2;" onclick="delI(\${gIdx}, \${iIdx})" title="删除">\${ICONS.del}</button>
            </div>
          </div>\`;
        });
        
        html += \`<button class="add-btn" onclick="addI(\${gIdx})">➕ 为 "\${g.name}" 添加条目</button></div>\`;
        div.innerHTML = html;
        container.appendChild(div);
      });
    }

    function toggleCard(el, e) {
      if(['INPUT', 'BUTTON', 'SELECT', 'LABEL'].includes(e.target.tagName) || e.target.closest('.color-picker') || e.target.closest('button')) {
        return;
      }
      const card = el.closest('.group-card');
      card.classList.toggle('expanded');
      
      const gIdx = card.dataset.index;
      configData.groups[gIdx]._expanded = card.classList.contains('expanded');
    }

    const updateG = (g, k, v) => configData.groups[g][k] = v;
    const updateI = (g, i, k, v) => configData.groups[g].items[i][k] = v;
    
    const swap = (arr, i, j) => { if(j>=0 && j<arr.length) [arr[i], arr[j]] = [arr[j], arr[i]]; };
    
    const moveG = (g, d, e) => { if(e) e.stopPropagation(); swap(configData.groups, g, g+d); render(); };
    const moveI = (g, i, d) => { swap(configData.groups[g].items, i, i+d); render(); };
    const delG = (g, e) => { if(e) e.stopPropagation(); if(confirm('确认删除整组节点吗？')) { configData.groups.splice(g, 1); render(); } };
    const delI = (g, i) => { configData.groups[g].items.splice(i, 1); render(); };
    const addG = () => { configData.groups.push({ id:'g'+Date.now(), name:'新节点组', color: 1, show:true, _expanded:true, items:[] }); render(); };
    const addI = (g) => { configData.groups[g].items.push({ name:'', path:'', target:'', show:true, enabled:true }); render(); };
    
    const togglePicker = (g, e) => {
      e.stopPropagation();
      document.querySelectorAll('.picker-grid').forEach(el => { if(el.id !== 'picker-'+g) el.classList.remove('active'); });
      document.getElementById('picker-'+g).classList.toggle('active');
    };
    const updateColor = (g, c) => { updateG(g, 'color', c); render(); };

    async function saveConfig() {
      const btn = document.getElementById('btnSaveConfig');
      btn.innerHTML = '🔄 正在同步保存...'; btn.disabled = true;
      try {
        const res = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(configData) });
        if((await res.json()).success) btn.innerHTML = '✅ 保存成功！'; else btn.innerHTML = '❌ 保存失败';
      } catch(e) { btn.innerHTML = '❌ 网络异常'; }
      setTimeout(() => { btn.innerHTML = '🚀 保存所有更改'; btn.disabled = false; }, 2000);
    }

    async function doBackup() {
      if(!confirm('是否备份当前所有配置数据？')) return;
      const r = await (await fetch('/api/backup', { method:'POST' })).json();
      alert(r.success ? '✅ 备份已生成：' + r.key : '❌ 备份失败');
    }
    async function showRestore() {
      const r = await (await fetch('/api/backup')).json();
      if(!r.success || !r.backups.length) return alert('暂无历史云端备份数据');
      const sel = document.getElementById('backupSelect'); sel.innerHTML = '';
      r.backups.sort().reverse().forEach(b => sel.appendChild(new Option(b, b)));
      document.getElementById('restoreModal').classList.add('active');
    }
    async function confirmRestore() {
      if(!confirm('警告：此操作将完全覆盖当前配置，是否继续？')) return;
      const key = document.getElementById('backupSelect').value;
      const r = await (await fetch('/api/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key}) })).json();
      if(r.success) { alert('✅ 恢复成功'); window.location.reload(); } else alert('❌ 恢复失败');
    }
    function doExport() { window.location.href = '/api/export'; }
    function doImport(e) {
      const file = e.target.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const json = JSON.parse(ev.target.result);
          if(!confirm('确定要导入此 JSON 并覆盖当前系统配置吗？')) return;
          const r = await (await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(json) })).json();
          if(r.success) { alert('✅ 导入成功'); window.location.reload(); }
        } catch(err) { alert('❌ JSON 文件格式错误'); }
        e.target.value = '';
      };
      reader.readAsText(file);
    }

    loadData();
  </script>
</body></html>`;
}

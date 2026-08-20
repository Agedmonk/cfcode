/**
 * 全球路由管理系统
 * 包含：登录验证、节点/路由前台展示、节点/路由后台管理、KV数据备份恢复功能
 */

const DEFAULT_PASSWORD = "NicholasLai";
const KV_DATA_KEY = "KV";

// 默认初始化的数据结构（保留了部分原有节点作为示例基座）
const DEFAULT_DATA = {
  nodes: [
    {
      id: "g_daily", name: "日常连接", show: true,
      items: [
        { id: "n_telecom", name: "电信网络", path: "niclai/chinatelecom", url: "https://chinatelecom.qingyuan.city/sub?token=fefd7730454a1d1bf4a89b3202de3c3d", color: "pink", show: true },
        { id: "n_cmcc", name: "移动网络", path: "niclai/cmcc", url: "https://cmcc.qingyuan.city/sub?token=df16f2c1fc47b0a4543b6c78cfe73224", color: "pink", show: true }
      ]
    },
    {
      id: "g_edge", name: "隧道连接", show: true,
      items: [
        { id: "n_edge_niclai", name: "个人机房", path: "edge/niclai.vip", url: "https://edge.niclai.vip/sub?token=102b3972db4ebfa502ec57efdb326578", color: "green", show: true }
      ]
    }
  ],
  routes: [
    {
      id: "rg_default", name: "基础路由", show: true,
      items: [
        { id: "r_google", name: "Google", path: "route/google", url: "https://www.google.com", color: "blue", enabled: true }
      ]
    }
  ]
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const hostname = url.hostname;

    // === 1. 鉴权拦截 ===
    const cookies = request.headers.get("Cookie") || "";
    const isAuthed = cookies.includes(`cf_auth=${DEFAULT_PASSWORD}`);

    if (path === "/login") {
      if (request.method === "POST") {
        const formData = await request.formData().catch(() => new FormData());
        const pass = formData.get("password");
        if (pass === DEFAULT_PASSWORD) {
          return new Response("登录成功", {
            status: 302,
            headers: { "Location": "/", "Set-Cookie": `cf_auth=${DEFAULT_PASSWORD}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax` }
          });
        }
        return new Response(getLoginPage("密码错误，请重试"), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      return new Response(getLoginPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (path === "/logout") {
      return new Response("已退出", { status: 302, headers: { "Location": "/login", "Set-Cookie": `cf_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax` } });
    }

    // === 2. API 路由 (需鉴权) ===
    if (path.startsWith("/api/")) {
      if (!isAuthed) return new Response("Unauthorized", { status: 401 });
      
      if (path === "/api/data" && request.method === "GET") return await handleGetData(env);
      if (path === "/api/data" && request.method === "POST") return await handleSaveData(request, env);
      
      if (path === "/api/backup" && request.method === "GET") return await handleListBackups(env);
      if (path === "/api/backup" && request.method === "POST") return await handleCreateBackup(env);
      if (path === "/api/restore" && request.method === "POST") return await handleRestoreBackup(request, env);
      if (path === "/api/export" && request.method === "GET") return await handleExportData(env);
      if (path === "/api/import" && request.method === "POST") return await handleImportData(request, env);
    }

    // === 3. 跨域代理端点 ===
    if (path === "/proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return new Response('Missing url', { status: 400 });
      try {
        const response = await fetch(targetUrl);
        const text = await response.text();
        return new Response(text, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response('Proxy error', { status: 502 });
      }
    }

    // === 4. 获取动态数据用于重定向匹配 ===
    let appData = DEFAULT_DATA;
    try {
      const raw = await env.KV.get(KV_DATA_KEY);
      if (raw) appData = JSON.parse(raw);
    } catch(e) {}

    // === 5. 页面路由 (需鉴权) ===
    if (path === "/" || path === "/routes" || path === "/manage-nodes" || path === "/manage-routes") {
      if (!isAuthed) return Response.redirect(url.origin + "/login", 302);
      return new Response(getAppPage(path, hostname, appData), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // === 6. 节点/路由快捷链接重定向 ===
    let key = path.replace(/^\/+|\/+$/g, '');
    const hostParts = hostname.split('.');
    const rootDomain = hostParts.length > 2 ? hostParts.slice(-2).join('.') : hostname;

    if (['niclai', 'edge', 'station', 'ss', 'freechina', 'bpb'].includes(key)) {
      key = `${key}/${rootDomain}`;
    }

    let targetRedirect = null;
    appData.nodes.forEach(g => g.items.forEach(i => { if (i.path === key && i.show !== false) targetRedirect = i.url; }));
    appData.routes.forEach(g => g.items.forEach(i => { if (i.path === key && i.enabled !== false) targetRedirect = i.url; }));

    if (targetRedirect) return Response.redirect(targetRedirect, 302);

    // 默认防线
    return Response.redirect(`https://www.${rootDomain}`, 302);
  }
};

// ==================== KV 数据管理 API ====================
async function handleGetData(env) {
  let data = DEFAULT_DATA;
  const raw = await env.KV.get(KV_DATA_KEY);
  if (raw) data = JSON.parse(raw);
  return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
}

async function handleSaveData(request, env) {
  const data = await request.json();
  await env.KV.put(KV_DATA_KEY, JSON.stringify(data));
  return new Response(JSON.stringify({ success: true }));
}

async function handleCreateBackup(env) {
  const raw = await env.KV.get(KV_DATA_KEY);
  if (!raw) return new Response(JSON.stringify({ success: false, error: "无数据可备份" }));
  const d = new Date(); d.setTime(d.getTime() + 8 * 3600000); // 补时区
  const pad = n => n.toString().padStart(2, '0');
  const key = `backup_${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  await env.KV.put(key, raw);
  return new Response(JSON.stringify({ success: true, key }), { headers: { "Content-Type": "application/json" } });
}

async function handleListBackups(env) {
  const listed = await env.KV.list({ prefix: "backup_" });
  return new Response(JSON.stringify({ success: true, backups: listed.keys.map(k => k.name) }), { headers: { "Content-Type": "application/json" } });
}

async function handleRestoreBackup(request, env) {
  const { key } = await request.json();
  const raw = await env.KV.get(key);
  if (raw) { await env.KV.put(KV_DATA_KEY, raw); return new Response(JSON.stringify({ success: true })); }
  return new Response(JSON.stringify({ success: false }), { status: 404 });
}

async function handleExportData(env) {
  const raw = await env.KV.get(KV_DATA_KEY) || JSON.stringify(DEFAULT_DATA);
  return new Response(raw, { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="routing_system_export.json"' } });
}

async function handleImportData(request, env) {
  const data = await request.json();
  await env.KV.put(KV_DATA_KEY, JSON.stringify(data));
  return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
}


// ==================== 共享样式 ====================
const GLOBAL_STYLE = `
  :root { --primary: #F6821F; --primary-hover: #e07010; --bg: #f4f4f4; --card-bg: #ffffff; --text: #333; --border: #eee; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 20px 10px; text-align: center; }
  .container { max-width: 650px; margin: 0 auto; background: var(--card-bg); padding: 20px; box-shadow: 0px 4px 15px rgba(0,0,0,0.1); border-radius: 15px; text-align: left;}
  h2 { color: #333; text-align: center; margin-bottom: 20px; }
  
  /* 表单与按钮 */
  input[type="text"], input[type="password"], input[type="url"], select { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px; outline: none; }
  input:focus { border-color: var(--primary); }
  button { border: none; border-radius: 6px; cursor: pointer; padding: 10px 15px; font-size: 13px; color: #fff; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
  .btn-primary { background: var(--primary); } .btn-primary:hover { background: var(--primary-hover); }
  .btn-danger { background: #dc3545; }
  .btn-icon { background: transparent; color: #666; padding: 5px; } .btn-icon:hover { color: var(--primary); background: #eee; }
  
  /* 前台展示页卡片 */
  .group-container { border: 1px solid var(--border); padding: 15px; margin-bottom: 20px; border-radius: 12px; background: #fff; text-align: center; }
  .group-title { font-size: 16px; font-weight: bold; color: #555; margin-bottom: 12px; display: flex; align-items: center; justify-content: center; }
  .group-title::before, .group-title::after { content: ""; flex: 1; height: 1px; background: var(--border); margin: 0 10px; }
  .btn-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  .node-btn { width: 30%; min-width: 90px; padding: 10px 5px; border-radius: 6px; color: white; font-size: 12px; }
  
  /* 颜色池 */
  .green { background-color: #28a745; } .orange { background-color: #fd7e14; } .red { background-color: #dc3545; } 
  .blue { background-color: #007bff; } .purple { background-color: #6f42c1; } .teal { background-color: #20c997; } .pink { background-color: #e83e8c; }
  
  /* 底部导航 */
  .bottom-nav { display: flex; justify-content: center; flex-wrap: wrap; gap: 15px; margin-top: 30px; padding-top: 15px; border-top: 1px solid var(--border); }
  .bottom-nav a { text-decoration: none; color: #666; font-size: 14px; font-weight: 500; padding: 8px 12px; border-radius: 6px; background: #f8f9fa; border: 1px solid var(--border); }
  .bottom-nav a.active { color: var(--primary); border-color: var(--primary); background: #fff3e0; }
  
  /* 后台管理列表 */
  .m-group { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 15px; background: #fafbfc; overflow: hidden; }
  .m-group-header { padding: 10px 15px; background: #f1f2f6; display: flex; justify-content: space-between; align-items: center; font-weight: bold; }
  .m-items { padding: 10px; }
  .m-item { display: flex; align-items: center; gap: 8px; background: #fff; border: 1px solid var(--border); padding: 8px; border-radius: 6px; margin-bottom: 8px; }
  .m-item input[type="text"] { margin-bottom: 0; padding: 6px; }
  .action-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
  
  /* 模态框 */
  .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
  .modal.active { display: flex; }
  .modal-content { background: #fff; padding: 20px; border-radius: 12px; width: 90%; max-width: 400px; text-align: left; }
`;

const ICONS = {
  up: '↑', down: '↓', del: '✖', add: '➕', save: '💾'
};

// ==================== 登录页 ====================
function getLoginPage(errorMsg = "") {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>全球路由管理系统 - 登录</title><style>${GLOBAL_STYLE}</style></head>
  <body style="display:flex;align-items:center;height:100vh;margin:0;"><div class="container" style="max-width:350px;text-align:center;">
    <h2 style="color:var(--primary);">全球路由管理系统</h2>
    ${errorMsg ? `<div style="color:red;margin-bottom:15px;font-size:13px;">${errorMsg}</div>` : ''}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="请输入系统密码" required autofocus>
      <button class="btn-primary" type="submit" style="width:100%;padding:12px;font-size:15px;">登 录</button>
    </form>
  </div></body></html>`;
}

// ==================== 综合应用页面 ====================
function getAppPage(currentPath, domain, appData) {
  const isManage = currentPath.includes("manage");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>全球路由管理系统</title><style>${GLOBAL_STYLE}</style></head><body>
  <div class="container">
    <h2>全球路由管理系统</h2>
    ${isManage ? renderBackupComponent() : `<div style="color:#888; text-align:center; margin-bottom:20px;">正在访问: ${domain}</div>`}
    
    <div id="app-content">
      ${currentPath === '/' ? renderDisplay(appData.nodes, 'node') : ''}
      ${currentPath === '/routes' ? renderDisplay(appData.routes, 'route') : ''}
      ${currentPath === '/manage-nodes' ? renderManage('nodes') : ''}
      ${currentPath === '/manage-routes' ? renderManage('routes') : ''}
    </div>

    <div class="bottom-nav">
      <a href="/" class="${currentPath === '/' ? 'active' : ''}">节点展示</a>
      <a href="/routes" class="${currentPath === '/routes' ? 'active' : ''}">路由展示</a>
      <a href="/manage-nodes" class="${currentPath === '/manage-nodes' ? 'active' : ''}">节点管理</a>
      <a href="/manage-routes" class="${currentPath === '/manage-routes' ? 'active' : ''}">路由管理</a>
      <a href="/logout" style="color:red;border-color:#f5c6cb;background:#f8d7da;">退出</a>
    </div>
  </div>

  ${isManage ? renderModalsAndScripts(appData, currentPath) : renderDisplayScripts(appData)}
  </body></html>`;
}

// --- 渲染展示页 (节点/路由共享逻辑) ---
function renderDisplay(groups, type) {
  let html = '';
  groups.forEach(g => {
    if (g.show === false) return;
    html += `<div class="group-container"><div class="group-title">${g.name}</div><div class="btn-grid">`;
    g.items.forEach(i => {
      if (type === 'node' && i.show === false) return;
      if (type === 'route' && i.enabled === false) return;
      html += `<button class="node-btn ${i.color || 'blue'}" onclick="fetchData('${i.path}')">${i.name}</button>`;
    });
    html += `</div></div>`;
  });

  if (type === 'node') {
    html += `
    <div class="group-container"><div class="group-title">工具箱</div><div class="btn-grid" style="flex-direction:column;align-items:center;">
      <div id="linkUrl" style="background:#eee;padding:10px;border-radius:5px;font-size:12px;width:100%;word-break:break-all;text-align:left;">点击上方获取订阅链接...</div>
      <button class="btn-primary" onclick="copyUrl()" style="width:80%;margin-top:10px;">复制订阅链接</button>
      
      <div id="sourceUrl" style="background:#eee;padding:10px;border-radius:5px;font-size:12px;width:100%;word-break:break-all;text-align:left;margin-top:10px;">真实地址...</div>
      <button class="btn-primary" onclick="copySourceUrl()" style="width:80%;margin-top:10px;">复制真实地址</button>

      <div id="output" style="background:#eee;padding:10px;border-radius:5px;font-size:12px;width:100%;word-break:break-all;text-align:left;min-height:50px;margin-top:10px;">节点内容...</div>
      <button class="btn-primary" onclick="copyText()" style="width:80%;margin-top:10px;">复制具体内容</button>
    </div></div>
    <div id="customAlert" style="position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#28a745;color:#fff;padding:10px 20px;border-radius:20px;display:none;z-index:1000;"></div>`;
  }
  return html;
}

// --- 渲染展示页交互 JS ---
function renderDisplayScripts(appData) {
  // 构建前端 MAPPINGS (将嵌套结构拍平给页面用)
  const map = {};
  appData.nodes.forEach(g => g.items.forEach(i => map[i.path] = i.url));
  appData.routes.forEach(g => g.items.forEach(i => map[i.path] = i.url));

  return `<script>
    const MAPPINGS = ${JSON.stringify(map)};
    
    function showAlert(msg) {
      const a = document.getElementById('customAlert');
      if(!a) { alert(msg); return; }
      a.textContent = msg; a.style.display = "block";
      setTimeout(() => a.style.display = "none", 2000);
    }

    function copyUrl() {
      const t = document.getElementById('linkUrl').textContent;
      if(!t || t.includes('点击')) return;
      navigator.clipboard.writeText(t).then(() => showAlert("订阅地址已复制"));
    }
    
    function copySourceUrl() {
      const t = document.getElementById('sourceUrl').textContent;
      if(!t || t.includes('点击') || t.includes('未在配置')) return;
      navigator.clipboard.writeText(t).then(() => showAlert("实际地址已复制"));
    }
    
    function copyText() {
      const t = document.getElementById('output').textContent;
      if(!t || t.includes('获取中')) return;
      navigator.clipboard.writeText(t).then(() => showAlert("节点内容已复制"));
    }

    async function fetchData(path) {
      const o = document.getElementById('output');
      const l = document.getElementById('linkUrl');
      const s = document.getElementById('sourceUrl');
      if(l) l.textContent = window.location.origin + '/' + path.replace(/^\\/+/, '');
      
      const realUrl = MAPPINGS[path];
      if(s) s.textContent = realUrl ? realUrl : "未在配置中找到此链接";
      
      if(!o) return; // 如果是路由页可能没有这个框
      o.textContent = "内容获取中...";
      if (!realUrl) { o.textContent = "未找到真实地址"; return; }
      
      try {
        const proxyUrl = window.location.origin + '/proxy?url=' + encodeURIComponent(realUrl);
        const r = await fetch(proxyUrl);
        o.textContent = r.ok ? await r.text() : "请求失败，状态码: " + r.status;
      } catch(e) {
        o.textContent = "内容获取失败，请重试";
      }
    }
  </script>`;
}

// --- 渲染备份组件 ---
function renderBackupComponent() {
  return `
    <div class="action-bar">
      <button class="btn-primary" onclick="sysBackup()" style="background:#28a745;">💾 备份</button>
      <button class="btn-primary" onclick="showRestoreModal()" style="background:#fd7e14;">⏪ 恢复</button>
      <button class="btn-primary" onclick="sysExport()" style="background:#6f42c1;">📤 导出</button>
      <button class="btn-primary" onclick="document.getElementById('importFile').click()" style="background:#007bff;">📥 导入</button>
      <input type="file" id="importFile" style="display:none" accept=".json" onchange="sysImport(this)">
    </div>
  `;
}

// --- 渲染管理容器 ---
function renderManage(dataType) {
  return `<div id="manage-editor" data-type="${dataType}"></div>
          <button class="btn-primary" onclick="addGroup()" style="width:100%;padding:12px;margin-top:15px;background:#6c757d;">${ICONS.add} 添加新分组</button>
          <button class="btn-primary" onclick="saveAllData()" style="width:100%;padding:12px;margin-top:10px;">${ICONS.save} 保存所有更改</button>`;
}

// --- 渲染管理交互脚本 (整合 Reactivity) ---
function renderModalsAndScripts(appData, currentPath) {
  const type = currentPath.includes("nodes") ? "nodes" : "routes";
  return `
  <!-- 恢复弹窗 -->
  <div id="restoreModal" class="modal">
    <div class="modal-content">
      <h3 style="margin-bottom:15px;">⏪ 选择备份文件恢复</h3>
      <select id="backupSelect" style="width:100%;margin-bottom:15px;"></select>
      <small style="color:red;display:block;margin-bottom:15px;">警告：将覆盖当前所有数据！</small>
      <div style="display:flex;gap:10px;">
        <button class="btn-primary" onclick="sysRestore()" style="flex:1;">确认恢复</button>
        <button class="btn-danger" onclick="closeModal('restoreModal')" style="flex:1;">取消</button>
      </div>
    </div>
  </div>

  <script>
    let appData = ${JSON.stringify(appData)};
    let activeType = "${type}"; 
    let activeList = appData[activeType] || [];

    // --- 界面渲染引擎 ---
    function renderEditor() {
      const container = document.getElementById('manage-editor');
      container.innerHTML = '';
      
      activeList.forEach((group, gIdx) => {
        const div = document.createElement('div');
        div.className = 'm-group';
        
        // 分组头部
        const toggleKey = activeType === 'nodes' ? 'show' : 'show';
        const toggleLabel = activeType === 'nodes' ? '显示' : '显示';
        
        let html = \`<div class="m-group-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="text" value="\${group.name}" onchange="updateGroup(\${gIdx}, 'name', this.value)" style="margin:0;width:120px;">
            <label style="font-size:12px;font-weight:normal;"><input type="checkbox" \${group[toggleKey] !== false ? 'checked' : ''} onchange="updateGroup(\${gIdx}, '\${toggleKey}', this.checked)"> \${toggleLabel}</label>
          </div>
          <div>
            <button class="btn-icon" onclick="moveGroup(\${gIdx}, -1)">\${ICONS.up}</button>
            <button class="btn-icon" onclick="moveGroup(\${gIdx}, 1)">\${ICONS.down}</button>
            <button class="btn-icon" onclick="delGroup(\${gIdx})" style="color:red;">\${ICONS.del}</button>
          </div>
        </div><div class="m-items">\`;

        // 条目列表
        const itemToggleKey = activeType === 'nodes' ? 'show' : 'enabled';
        const itemToggleLabel = activeType === 'nodes' ? '显示' : '启用';

        group.items.forEach((item, iIdx) => {
          html += \`<div class="m-item">
            <div style="flex:1;display:flex;flex-direction:column;gap:5px;">
              <div style="display:flex;gap:5px;">
                <input type="text" placeholder="名称" value="\${item.name || ''}" onchange="updateItem(\${gIdx}, \${iIdx}, 'name', this.value)" style="flex:1;">
                <input type="text" placeholder="路径 (如 xx/yy)" value="\${item.path || ''}" onchange="updateItem(\${gIdx}, \${iIdx}, 'path', this.value)" style="flex:2;">
                <select onchange="updateItem(\${gIdx}, \${iIdx}, 'color', this.value)" style="width:80px;margin-bottom:0;">
                  <option value="blue" \${item.color==='blue'?'selected':''}>Blue</option>
                  <option value="green" \${item.color==='green'?'selected':''}>Green</option>
                  <option value="pink" \${item.color==='pink'?'selected':''}>Pink</option>
                  <option value="orange" \${item.color==='orange'?'selected':''}>Orange</option>
                  <option value="red" \${item.color==='red'?'selected':''}>Red</option>
                  <option value="purple" \${item.color==='purple'?'selected':''}>Purple</option>
                  <option value="teal" \${item.color==='teal'?'selected':''}>Teal</option>
                </select>
              </div>
              <input type="url" placeholder="订阅链接/目标真实URL" value="\${item.url || ''}" onchange="updateItem(\${gIdx}, \${iIdx}, 'url', this.value)">
              <label style="font-size:12px;"><input type="checkbox" \${item[itemToggleKey] !== false ? 'checked' : ''} onchange="updateItem(\${gIdx}, \${iIdx}, '\${itemToggleKey}', this.checked)"> \${itemToggleLabel}</label>
            </div>
            <div style="display:flex;flex-direction:column;">
              <button class="btn-icon" onclick="moveItem(\${gIdx}, \${iIdx}, -1)">\${ICONS.up}</button>
              <button class="btn-icon" onclick="moveItem(\${gIdx}, \${iIdx}, 1)">\${ICONS.down}</button>
              <button class="btn-icon" onclick="delItem(\${gIdx}, \${iIdx})" style="color:red;margin-top:auto;">\${ICONS.del}</button>
            </div>
          </div>\`;
        });

        html += \`<button class="btn-icon" onclick="addItem(\${gIdx})" style="width:100%;border:1px dashed #ccc;margin-top:5px;">\${ICONS.add} 添加条目</button></div>\`;
        div.innerHTML = html;
        container.appendChild(div);
      });
    }

    // --- 数据操作逻辑 ---
    function moveArr(arr, idx, dir) { const t = idx+dir; if(t<0||t>=arr.length) return false; [arr[idx], arr[t]] = [arr[t], arr[idx]]; return true; }
    
    function addGroup() { activeList.push({ id: 'g_'+Date.now(), name: "新分组", show: true, items: [] }); renderEditor(); }
    function delGroup(gIdx) { if(confirm("确定删除此分组及其所有条目吗？")) { activeList.splice(gIdx, 1); renderEditor(); } }
    function moveGroup(gIdx, dir) { if(moveArr(activeList, gIdx, dir)) renderEditor(); }
    function updateGroup(gIdx, key, val) { activeList[gIdx][key] = val; }

    function addItem(gIdx) { activeList[gIdx].items.push({ id: 'i_'+Date.now(), name: "新条目", path: "", url: "", color: "blue", show: true, enabled: true }); renderEditor(); }
    function delItem(gIdx, iIdx) { activeList[gIdx].items.splice(iIdx, 1); renderEditor(); }
    function moveItem(gIdx, iIdx, dir) { if(moveArr(activeList[gIdx].items, iIdx, dir)) renderEditor(); }
    function updateItem(gIdx, iIdx, key, val) { activeList[gIdx].items[iIdx][key] = val; }

    async function saveAllData() {
      appData[activeType] = activeList;
      try {
        const res = await fetch('/api/data', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(appData) });
        const data = await res.json();
        if(data.success) alert('✅ 保存成功！'); else alert('❌ 保存失败');
      } catch(e) { alert('请求出错'); }
    }

    // --- 备份/恢复逻辑 ---
    function closeModal(id) { document.getElementById(id).classList.remove('active'); }
    
    async function sysBackup() {
      if(!confirm('确定将当前配置备份到KV吗？')) return;
      const r = await (await fetch('/api/backup', { method:'POST' })).json();
      alert(r.success ? '✅ 备份成功！\\n标识: '+r.key : '❌ 备份失败');
    }
    
    async function showRestoreModal() {
      const r = await (await fetch('/api/backup')).json();
      if(!r.success || r.backups.length === 0) return alert('没有找到任何备份文件');
      const sel = document.getElementById('backupSelect'); sel.innerHTML = '';
      r.backups.sort().reverse().forEach(b => sel.appendChild(new Option(b, b)));
      document.getElementById('restoreModal').classList.add('active');
    }
    
    async function sysRestore() {
      const key = document.getElementById('backupSelect').value;
      if(!confirm('该操作将覆盖所有数据，确定恢复吗？')) return;
      const r = await (await fetch('/api/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({key}) })).json();
      if(r.success) { alert('✅ 恢复成功'); location.reload(); } else alert('❌ 恢复失败');
    }

    function sysExport() { window.location.href = '/api/export'; }

    function sysImport(input) {
      const file = input.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = async e => {
        try {
          const json = JSON.parse(e.target.result);
          if(!confirm('确定导入并覆盖当前数据吗？')) return;
          const r = await (await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: e.target.result })).json();
          if(r.success) { alert('✅ 导入成功'); location.reload(); } else alert('❌ 导入失败');
        } catch(err) { alert('❌ JSON 格式错误'); }
        input.value = '';
      };
      reader.readAsText(file);
    }

    // 初始化渲染
    window.onload = renderEditor;
  </script>`;
}

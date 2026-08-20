const DEFAULT_REPOSITORIES_PATH = 'https://raw.githubusercontent.com/LaiJunLing/team/refs/heads/main/'

// 默认的初始数据（包含密码、路由映射、节点分组及条目）
const DEFAULT_DATA = {
  password: '123456',
  // 路由分组/映射（包含 target 目标地址与 enabled 使能开关，默认 true）
  routes: {
    'zhaoqing': { target: DEFAULT_REPOSITORIES_PATH + 'station-zhaoqing.txt', enabled: true },
    'sihui': { target: DEFAULT_REPOSITORIES_PATH + 'station-sihui.txt', enabled: true },
    'niclai': { target: DEFAULT_REPOSITORIES_PATH + 'station-niclai.txt', enabled: true },
    'oracle': { target: DEFAULT_REPOSITORIES_PATH + 'oracle.txt', enabled: true },
    'oracle2': { target: DEFAULT_REPOSITORIES_PATH + 'oracle2.txt', enabled: true },
    'NicholasLai': { target: DEFAULT_REPOSITORIES_PATH + 'allnodes.txt', enabled: true },
    'allnodes': { target: DEFAULT_REPOSITORIES_PATH + 'allnodes.txt', enabled: true },
    'auto': { target: DEFAULT_REPOSITORIES_PATH + 'auto.txt', enabled: true }
  },
  // 节点分组及条目（用于主页呈现页面的排版与显示）
  groups: [
    {
      id: 'g1',
      name: '默认分组',
      color: '#f6821f',
      show: true,
      items: [
        { name: 'zhaoqing', path: 'zhaoqing', show: true },
        { name: 'sihui', path: 'sihui', show: true },
        { name: 'niclai', path: 'niclai', show: true },
        { name: 'oracle', path: 'oracle', show: true },
        { name: 'oracle2', path: 'oracle2', show: true },
        { name: 'NicholasLai', path: 'NicholasLai', show: true },
        { name: 'allnodes', path: 'allnodes', show: true },
        { name: 'auto', path: 'auto', show: true }
      ]
    }
  ]
};

async function getStoredData(KV) {
  if (!KV) return DEFAULT_DATA;
  const data = await KV.get('app_config', 'json');
  if (!data) {
    await KV.put('app_config', JSON.stringify(DEFAULT_DATA));
    return DEFAULT_DATA;
  }
  // 兼容旧版纯字符串路由数据结构，自动升级为对象
  for (const k in data.routes) {
    if (typeof data.routes[k] === 'string') {
      data.routes[k] = { target: data.routes[k], enabled: true };
    }
  }
  return data;
}

async function saveStoredData(KV, data) {
  if (KV) {
    await KV.put('app_config', JSON.stringify(data));
  }
}

function checkAuth(request) {
  const cookie = request.headers.get('Cookie') || '';
  return cookie.includes('auth_session=true');
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const key = url.pathname.replace(/^\/+|\/+$/g, '');
      const KV = env.KV;
      const data = await getStoredData(KV);

      // 1. 登录页与登录接口
      if (key === 'login') {
        if (request.method === 'POST') {
          const formData = await request.formData();
          const pwd = formData.get('password');
          if (pwd === (data.password || '123456')) {
            return new Response(null, {
              status: 302,
              headers: {
                'Location': '/admin',
                'Set-Cookie': 'auth_session=true; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400'
              }
            });
          }
          return new Response(renderLogin('密码错误'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return new Response(renderLogin(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // 2. 后台设置页面
      if (key === 'admin') {
        if (!checkAuth(request)) {
          return Response.redirect(new URL('/login', request.url), 302);
        }
        
        if (request.method === 'POST') {
          const body = await request.json();
          
          if (body.action === 'save') {
            data.groups = body.groups;
            data.routes = body.routes;
            if (body.password) data.password = body.password;
            await saveStoredData(KV, data);
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
          }
          
          if (body.action === 'backup') {
            const now = new Date();
            const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const backupName = `nodesbackup_${dateStr}`;
            if (KV) {
              await KV.put(backupName, JSON.stringify(data));
            }
            return new Response(JSON.stringify({ success: true, name: backupName }), { headers: { 'Content-Type': 'application/json' } });
          }
          
          if (body.action === 'restore') {
            if (KV) {
              const val = await KV.get(body.name, 'json');
              if (val) {
                await KV.put('app_config', JSON.stringify(val));
                return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
              }
            }
            return new Response(JSON.stringify({ success: false, error: '备份不存在' }), { headers: { 'Content-Type': 'application/json' } });
          }
        }

        let backups = [];
        if (KV) {
          const list = await KV.list({ prefix: 'nodesbackup_' });
          backups = list.keys.map(k => k.name).sort().reverse();
        }
        return new Response(renderAdmin(data, backups), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // 3. KV 快捷连接入口
      if (key === 'KV') {
        return Response.redirect(new URL('/admin', request.url), 302);
      }

      // 4. 原有业务：SS 链接重定向
      if (key === 'ss') {
        return Response.redirect('https://ss.niclai.vip/sub/226279dd-28b2-4b61-96be-a2a0b1afd522', 302);
      }

      // 5. 动态路由转发（校验是否存在且处于 enabled 状态）
      if (key in data.routes) {
        const routeObj = data.routes[key];
        if (!routeObj || routeObj.enabled === false) {
          return new Response('Route Disabled or Not Found', { status: 403 });
        }

        const target = routeObj.target;
        const upstream = await fetch(target, {
          method: 'GET',
          headers: { 'Accept': 'text/plain, */*;q=0.1' },
          cf: { cacheTtl: 60, cacheEverything: true }
        });

        const body = await upstream.text();
        const headers = new Headers();
        headers.set('Content-Type', 'text/plain; charset=utf-8');
        headers.set('Cache-Control', 'public, max-age=60');

        return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
      }

      // 6. 主页呈现页
      if (key === '') {
        return new Response(renderHome(data), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // 7. 默认外部跳转
      return Response.redirect('https://www.niclai.vip', 302);

    } catch (err) {
      return new Response('Internal Error: ' + String(err), { status: 500 });
    }
  }
};

function renderLogin(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>登录 - Cloudflare</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f3f3; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .login-card { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 320px; border-top: 4px solid #f6821f; }
    h2 { margin-top: 0; color: #f6821f; font-size: 24px; text-align: center; margin-bottom: 24px; }
    input { width: 100%; padding: 10px; margin-bottom: 16px; border: 1px solid #d9d9d9; border-radius: 4px; box-sizing: border-box; }
    button { width: 100%; background: #f6821f; color: white; border: none; padding: 10px; border-radius: 4px; font-weight: bold; cursor: pointer; }
    button:hover { background: #e07218; }
    .error { color: #d93838; font-size: 14px; margin-bottom: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="login-card">
    <h2>Cloudflare</h2>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST">
      <input type="password" name="password" placeholder="请输入密码 (默认123456)" required autofocus>
      <button type="submit">登录</button>
    </form>
  </div>
</body>
</html>`;
}

function renderHome(data) {
  let groupsHtml = '';
  data.groups.forEach(g => {
    if (!g.show) return;
    let itemsHtml = '';
    g.items.forEach(i => {
      if (!i.show) return;
      // 可选：如果该路由被禁用，呈现页可以不展示或照常展示
      itemsHtml += `<a class="node-item" href="/${i.path}">${i.name}</a>`;
    });
    if (itemsHtml) {
      groupsHtml += `
        <div class="group-box" style="border-left-color: ${g.color || '#f6821f'}">
          <h3 style="color: ${g.color || '#f6821f'}">${g.name}</h3>
          <div class="nodes-grid">${itemsHtml}</div>
        </div>`;
    }
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>节点路由中心</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f9fa; color: #333; margin: 0; padding: 40px 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 1px solid #e1e4e8; padding-bottom: 15px; }
    h1 { margin: 0; font-size: 24px; color: #f6821f; }
    .admin-link { color: #666; text-decoration: none; font-size: 14px; padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; }
    .admin-link:hover { background: #f3f4f6; color: #f6821f; border-color: #f6821f; }
    .group-box { background: white; border: 1px solid #e1e4e8; border-left-width: 6px; border-radius: 6px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
    .group-box h3 { margin-top: 0; margin-bottom: 15px; font-size: 18px; }
    .nodes-grid { display: flex; flex-wrap: wrap; gap: 10px; }
    .node-item { background: #f3f4f6; color: #1f2937; padding: 8px 16px; border-radius: 4px; text-decoration: none; font-size: 14px; border: 1px solid #e5e7eb; transition: all 0.2s; }
    .node-item:hover { background: #f6821f; color: white; border-color: #f6821f; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Cloudflare 节点导航</h1>
      <a class="admin-link" href="/admin">进入管理后台</a>
    </header>
    <main>
      ${groupsHtml || '<p style="text-align:center; color:#888;">暂无显示的分组或节点</p>'}
    </main>
  </div>
</body>
</html>`;
}

function renderAdmin(data, backups) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>控制面板 - Cloudflare 管理</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fafafa; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 950px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    h1 { color: #f6821f; font-size: 22px; margin-top: 0; display: flex; justify-content: space-between; align-items: center; }
    .toolbar { background: #fff8f3; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; border: 1px solid #fdecd2; }
    button { background: #f6821f; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    button:hover { background: #e07218; }
    button.secondary { background: #666; }
    button.secondary:hover { background: #444; }
    button.danger { background: #d93838; }
    button.danger:hover { background: #b82b2b; }
    .section-title { font-size: 16px; font-weight: bold; margin: 20px 0 10px; border-bottom: 2px solid #f6821f; padding-bottom: 5px; display: flex; justify-content: space-between; align-items: center; }
    .group-card { background: #fff; border: 1px solid #e1e1e1; border-left-width: 6px; border-radius: 6px; margin-bottom: 15px; padding: 15px; }
    .group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px; }
    .item-row, .route-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; background: #f9f9f9; padding: 8px; border-radius: 4px; }
    input[type="text"], input[type="password"] { padding: 5px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
    input[type="color"] { border: none; width: 30px; height: 26px; cursor: pointer; background: none; }
    label { font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
    select { padding: 5px; border-radius: 4px; border: 1px solid #ccc; }
    .back-home { color: #f6821f; text-decoration: none; font-size: 14px; font-weight: normal; }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <span>Cloudflare 节点与路由管理面板</span>
      <div style="display:flex; gap:10px; align-items:center;">
        <a class="back-home" href="/" target="_blank">查看主页</a>
        <button onclick="saveAll()">保存全部修改</button>
      </div>
    </h1>
    
    <div class="toolbar">
      <strong>KV 数据备份与传导：</strong>
      <button onclick="doBackup()">备份到KV</button>
      <select id="backupSelect">
        ${backups.map(b => `<option value="${b}">${b}</option>`).join('')}
      </select>
      <button class="secondary" onclick="doRestore()">恢复所选备份</button>
      <button class="secondary" onclick="exportJSON()">导出配置</button>
      <button class="secondary" onclick="document.getElementById('importFile').click()">导入配置</button>
      <input type="file" id="importFile" style="display:none" onchange="importJSON(event)">
      <div style="margin-left:auto;">
        修改密码：<input type="password" id="newPassword" placeholder="留空则不改" style="width:100px;">
      </div>
    </div>

    <!-- 一、节点分组及条目管理 -->
    <div class="section-title">
      <span>一、节点分组及条目管理（主页展示）</span>
      <button onclick="addGroup()">+ 添加分组</button>
    </div>
    <div id="groupsContainer"></div>

    <!-- 二、路由分组及条目管理 (API 映射) -->
    <div class="section-title">
      <span>二、路由映射管理（API/链接获取源）</span>
      <button onclick="addRoute()">+ 添加路由映射</button>
    </div>
    <div id="routesContainer"></div>
  </div>

  <script>
    let appData = ${JSON.stringify(data)};
    if (!appData.routes) appData.routes = {};

    function render() {
      renderGroups();
      renderRoutes();
    }

    function renderGroups() {
      const container = document.getElementById('groupsContainer');
      container.innerHTML = '';
      
      appData.groups.forEach((g, gIdx) => {
        const card = document.createElement('div');
        card.className = 'group-card';
        card.style.borderLeftColor = g.color || '#f6821f';
        
        card.innerHTML = \`
          <div class="group-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="color" value="\${g.color || '#f6821f'}" onchange="updateGroupProp(\${gIdx}, 'color', this.value)" title="点击选择边框色调">
              <input type="text" value="\${g.name}" oninput="updateGroupProp(\${gIdx}, 'name', this.value)" placeholder="分组名称" style="font-weight:bold;">
              <label><input type="checkbox" \${g.show ? 'checked' : ''} onchange="updateGroupProp(\${gIdx}, 'show', this.checked)"> 显示</label>
            </div>
            <div style="display:flex; gap:4px;">
              \${gIdx > 0 ? \`<button class="secondary" onclick="moveGroup(\${gIdx}, -1)">↑</button>\` : ''}
              \${gIdx < appData.groups.length - 1 ? \`<button class="secondary" onclick="moveGroup(\${gIdx}, 1)">↓</button>\` : ''}
              <button class="danger" onclick="deleteGroup(\${gIdx})">删除分组</button>
            </div>
          </div>
          <div class="items-list" id="items-\${gIdx}"></div>
          <div style="margin-top:8px;">
            <button style="font-size:12px; padding:4px 8px;" onclick="addItem(\${gIdx})">+ 添加条目</button>
          </div>
        \`;
        
        const itemsList = card.querySelector('#items-' + gIdx);
        g.items.forEach((item, iIdx) => {
          const row = document.createElement('div');
          row.className = 'item-row';
          row.innerHTML = \`
            <input type="text" value="\${item.name}" placeholder="条目名称" oninput="updateItemProp(\${gIdx}, \${iIdx}, 'name', this.value)">
            <input type="text" value="\${item.path}" placeholder="对应路由路径 (如 zhaoqing)" oninput="updateItemProp(\${gIdx}, \${iIdx}, 'path', this.value)" style="flex:1;">
            <label><input type="checkbox" \${item.show ? 'checked' : ''} onchange="updateItemProp(\${gIdx}, \${iIdx}, 'show', this.checked)"> 显示</label>
            <div style="display:flex; gap:4px;">
              \${iIdx > 0 ? \`<button class="secondary" style="padding:2px 6px;" onclick="moveItem(\${gIdx}, \${iIdx}, -1)">↑</button>\` : ''}
              \${iIdx < g.items.length - 1 ? \`<button class="secondary" style="padding:2px 6px;" onclick="moveItem(\${gIdx}, \${iIdx}, 1)">↓</button>\` : ''}
              <button class="danger" style="padding:2px 6px;" onclick="deleteItem(\${gIdx}, \${iIdx})">删除</button>
            </div>
          \`;
          itemsList.appendChild(row);
        });
        
        container.appendChild(card);
      });
    }

    function renderRoutes() {
      const container = document.getElementById('routesContainer');
      container.innerHTML = '';
      
      const routeKeys = Object.keys(appData.routes);
      routeKeys.forEach((key, rIdx) => {
        const routeObj = appData.routes[key];
        const targetVal = typeof routeObj === 'object' ? routeObj.target : routeObj;
        const isEnabled = typeof routeObj === 'object' ? (routeObj.enabled !== false) : true;

        const row = document.createElement('div');
        row.className = 'route-row';
        row.innerHTML = \`
          <input type="text" value="\${key}" placeholder="路径 Key (如 zhaoqing)" onchange="updateRouteKey('\${key}', this.value)" style="width:160px;">
          <input type="text" value="\${targetVal}" placeholder="远程节点连接/API地址 (URL)" oninput="appData.routes['\${key}'].target = this.value" style="flex:1;">
          <label><input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="appData.routes['\${key}'].enabled = this.checked"> 启用</label>
          <button class="danger" style="padding:4px 8px;" onclick="deleteRoute('\${key}')">删除</button>
        \`;
        container.appendChild(row);
      });
    }

    function updateGroupProp(gIdx, prop, val) { appData.groups[gIdx][prop] = val; if(prop === 'color') renderGroups(); }
    function updateItemProp(gIdx, iIdx, prop, val) { appData.groups[gIdx].items[iIdx][prop] = val; }
    
    function addGroup() {
      appData.groups.push({ id: 'g_' + Date.now(), name: '新分组', color: '#3b82f6', show: true, items: [] });
      renderGroups();
    }
    function deleteGroup(gIdx) { if(confirm('确定删除该分组吗？')) { appData.groups.splice(gIdx, 1); renderGroups(); } }
    
    function addItem(gIdx) {
      appData.groups[gIdx].items.push({ name: '', path: '', show: true });
      renderGroups();
    }
    function deleteItem(gIdx, iIdx) { appData.groups[gIdx].items.splice(iIdx, 1); renderGroups(); }

    function moveGroup(idx, dir) {
      const target = idx + dir;
      const temp = appData.groups[idx];
      appData.groups[idx] = appData.groups[target];
      appData.groups[target] = temp;
      renderGroups();
    }

    function moveItem(gIdx, idx, dir) {
      const items = appData.groups[gIdx].items;
      const target = idx + dir;
      const temp = items[idx];
      items[idx] = items[target];
      items[target] = temp;
      renderGroups();
    }

    function addRoute() {
      let newKey = 'new_path_' + Date.now().toString().slice(-4);
      appData.routes[newKey] = { target: 'https://', enabled: true };
      renderRoutes();
    }

    function updateRouteKey(oldKey, newKey) {
      newKey = newKey.trim();
      if (!newKey || oldKey === newKey) return;
      if (appData.routes[newKey]) {
        alert('该路径 Key 已存在！');
        renderRoutes();
        return;
      }
      appData.routes[newKey] = appData.routes[oldKey];
      delete appData.routes[oldKey];
      renderRoutes();
    }

    function deleteRoute(key) {
      if (confirm('确定删除路由映射 [' + key + '] 吗？')) {
        delete appData.routes[key];
        renderRoutes();
      }
    }

    async function saveAll() {
      const pwd = document.getElementById('newPassword').value;
      const payload = { action: 'save', groups: appData.groups, routes: appData.routes };
      if (pwd) payload.password = pwd;
      
      const res = await fetch('/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.success) alert('保存成功！所有配置已写入 KV。');
      else alert('保存失败');
    }

    async function doBackup() {
      const res = await fetch('/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'backup' })
      });
      const json = await res.json();
      if (json.success) {
        alert('备份成功: ' + json.name);
        location.reload();
      } else alert('备份失败');
    }

    async function doRestore() {
      const name = document.getElementById('backupSelect').value;
      if (!name) return alert('请先选择一个备份文件');
      if (!confirm('确定要恢复备份 [' + name + '] 吗？当前未保存的修改将被覆盖。')) return;
      
      const res = await fetch('/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', name })
      });
      const json = await res.json();
      if (json.success) {
        alert('恢复成功！');
        location.reload();
      } else alert('恢复失败');
    }

    function exportJSON() {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData, null, 2));
      const dlAnchor = document.createElement('a');
      dlAnchor.setAttribute("href", dataStr);
      dlAnchor.setAttribute("download", "nodes_and_routes_export.json");
      document.body.appendChild(dlAnchor);
      dlAnchor.click();
      dlAnchor.remove();
    }

    function importJSON(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const parsed = JSON.parse(e.target.result);
          if (parsed.groups && parsed.routes) {
            appData = parsed;
            render();
            alert('导入成功，请点击右上角“保存全部修改”将数据写入 KV！');
          } else {
            alert('文件格式错误（必须包含 groups 和 routes）');
          }
        } catch(err) {
          alert('解析 JSON 失败');
        }
      };
      reader.readAsText(file);
    }

    render();
  </script>
</body>
</html>`;
}

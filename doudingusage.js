export default {
  async fetch(request, env, _ctx) {
    try {
      // ==================== 自定义页面密码验证逻辑 ====================
      const password = env.PASSWORD || '207'; 
      const url = new URL(request.url);
      
      const cookieHeader = request.headers.get('Cookie') || '';
      let isAuthorized = cookieHeader.includes(`site_auth=${password}`);
      
      const authHeader = request.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Basic ')) {
        const credentials = atob(authHeader.substring(6));
        const parts = credentials.split(':');
        if (parts.slice(1).join(':') === password) isAuthorized = true;
      }

      if (request.method === 'POST' && url.searchParams.get('auth_action') === 'login') {
        const formData = await request.formData().catch(() => new FormData());
        if (formData.get('password') === password) {
          const redirectUrl = new URL(request.url);
          redirectUrl.searchParams.delete('auth_action');
          redirectUrl.searchParams.delete('error');
          return new Response(null, {
            status: 302,
            headers: {
              'Location': redirectUrl.pathname + redirectUrl.search,
              'Set-Cookie': `site_auth=${password}; Path=/; HttpOnly; Max-Age=2592000`,
            }
          });
        } else {
          const redirectUrl = new URL(request.url);
          redirectUrl.searchParams.set('error', '1');
          return Response.redirect(redirectUrl.href, 302);
        }
      }

      if (!isAuthorized) {
        if (url.pathname.includes('/api')) {
          return new Response(JSON.stringify({ code: 401, message: 'Unauthorized' }), { 
            status: 401, headers: { 'Content-Type': 'application/json' } 
          });
        }
        
        const isError = url.searchParams.get('error') === '1';
        const loginHtml = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>安全访问验证</title>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-100 h-screen flex items-center justify-center p-4">
          <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm border border-gray-100">
            <div class="text-center mb-8">
              <div class="bg-blue-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg class="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
              </div>
              <h2 class="text-xl font-bold text-gray-800">系统访问验证</h2>
              <p class="text-xs text-gray-500 mt-2">请输入管理密码以继续访问</p>
            </div>
            <form method="POST" action="?auth_action=login" class="space-y-5">
              <div>
                <input type="password" name="password" required autofocus
                       class="w-full px-4 py-3 rounded-lg border border-gray-200 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-sm" 
                       placeholder="请输入密码">
              </div>
              ${isError ? `<div class="text-red-500 text-xs text-center bg-red-50 py-2 rounded">? 密码错误，请重试</div>` : ''}
              <button type="submit" 
                      class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg transition duration-200 shadow-md text-sm">
                解 锁 进 入
              </button>
            </form>
          </div>
        </body>
        </html>
        `;
        return new Response(loginHtml, {
          status: 401,
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
      // ==================== 密码验证逻辑结束 ====================

      if (!env.KV) {
        throw new Error("KV 未绑定。请检查环境变量配置。");
      }

      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      
      const hostname = url.hostname;
      const segments = path.split('/').filter(Boolean);

      if (segments[0] !== 'douding') {
        return Response.redirect(getMainDomainUrl(hostname), 302);
      }

      // === 访问 /douding 时执行智能跳转 ===
      if (segments.length === 1) return await handleRedirectPage(env);
      
      if (segments.length === 2) {
        const route = segments[1];
        
        // === 访问 /douding/detail 时展示用量大盘 ===
        if (route === 'detail') {
          return await handleDisplayPage(env);
        }
        
        if (route === 'setting') {
          const action = url.searchParams.get('action');
          if (action === 'backup' && request.method === 'POST') return await handleBackupSettings(env);
          if (action === 'list_backups' && request.method === 'GET') return await handleListBackups(env);
          if (action === 'restore' && request.method === 'POST') return await handleRestoreSettings(request, env);
          if (action === 'export' && request.method === 'GET') return await handleExportSettings(env);
          if (action === 'import' && request.method === 'POST') return await handleImportSettings(request, env);
          
          if (request.method === 'POST') return await handleSaveSettings(request, env);
          return await handleSettingPage(env);
        }
        if (route === 'api') return await handleGlobalApi(env);
        const tag = decodeURIComponent(route);
        return await handleSpecificDisplayPage(env, tag, hostname);
      }
      if (segments.length === 3 && segments[1] === 'api') {
        const tag = decodeURIComponent(segments[2]);
        return await handleSpecificApi(env, tag);
      }

      return Response.redirect(getMainDomainUrl(hostname), 302);
    } catch (error) {
      return new Response(`[系统错误]\n${error.message}`, { status: 500, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }
  }
};

// ==================== 数据备份与导入导出功能 ====================
async function handleBackupSettings(env) {
  const nodesData = await env.KV.get('WORKER_CONFIG') || '[]';
  const globalData = await env.KV.get('GLOBAL_CONFIG') || '{}';
  
  const backupPayload = JSON.stringify({
    type: 'douding_backup_v2',
    nodes: JSON.parse(nodesData),
    global: JSON.parse(globalData)
  });
  
  const tzOffset = 8 * 60 * 60 * 1000;
  const localDate = new Date(Date.now() + tzOffset);
  const timeStr = localDate.toISOString().replace('T', '_').replace(/:/g, '-').split('.')[0];
  const key = `backup_${timeStr}`;
  
  await env.KV.put(key, backupPayload);
  return new Response(JSON.stringify({ success: true, key }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleListBackups(env) {
  const list = await env.KV.list({ prefix: 'backup_' });
  const keys = list.keys.map(k => k.name).sort().reverse();
  return new Response(JSON.stringify({ success: true, backups: keys }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleRestoreSettings(request, env) {
  const { key } = await request.json();
  if (!key) return new Response(JSON.stringify({ error: '缺少备份键名' }), { status: 400 });
  const rawData = await env.KV.get(key);
  if (!rawData) return new Response(JSON.stringify({ error: '找不到对应的备份' }), { status: 404 });
  
  try {
    const parsed = JSON.parse(rawData);
    if (parsed.type === 'douding_backup_v2') {
      await env.KV.put('WORKER_CONFIG', JSON.stringify(parsed.nodes || []));
      await env.KV.put('GLOBAL_CONFIG', JSON.stringify(parsed.global || {}));
    } else {
      await env.KV.put('WORKER_CONFIG', rawData);
    }
  } catch (e) {
    await env.KV.put('WORKER_CONFIG', rawData);
  }
  
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleExportSettings(env) {
  const nodesData = await env.KV.get('WORKER_CONFIG') || '[]';
  const globalData = await env.KV.get('GLOBAL_CONFIG') || '{}';
  
  const exportPayload = JSON.stringify({
    type: 'douding_backup_v2',
    nodes: JSON.parse(nodesData),
    global: JSON.parse(globalData)
  }, null, 2);

  return new Response(exportPayload, {
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-Disposition': 'attachment; filename="cloudflare_accounts_backup.json"'
    }
  });
}

async function handleImportSettings(request, env) {
  try {
    const data = await request.json();
    if (data.type === 'douding_backup_v2') {
      await env.KV.put('WORKER_CONFIG', JSON.stringify(data.nodes || []));
      await env.KV.put('GLOBAL_CONFIG', JSON.stringify(data.global || {}));
    } else if (Array.isArray(data)) {
      await env.KV.put('WORKER_CONFIG', JSON.stringify(data));
    } else {
      throw new Error("无效的格式");
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: '解析 JSON 失败或格式错误' }), { status: 400 });
  }
}

// ==================== 工具函数 ====================
function getMainDomainUrl(hostname) {
  return `https://${hostname}/douding`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ==================== 核心逻辑：获取单节点总量 ====================
async function fetchTotalUsage(userId, apiKey) {
  const defaultReturn = { totalCount: null, debugInfo: "" };
  if (!userId || !apiKey) return defaultReturn;

  const now = new Date();
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const endTimeUtc = now.toISOString();

  // 合并为一个查询，直接利用 Cloudflare 聚合查询总数
  const query = `
    query { viewer { accounts(filter: {accountTag: "${userId}"}) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}" }) {
        dimensions { date } sum { requests }
      }
      pages: pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}" }) {
        dimensions { date } sum { requests }
      }
    }}}`;

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ query })
    });
    
    const json = await res.json();
    if (json.errors) return { totalCount: null, debugInfo: json.errors[0].message };
    
    const account = json.data?.viewer?.accounts?.[0];
    if (!account) return { totalCount: null, debugInfo: "账户未找到" };

    let total = 0;
    (account.workers || []).forEach(row => total += (row?.sum?.requests || 0));
    (account.pages || []).forEach(row => total += (row?.sum?.requests || 0));

    return { totalCount: total, debugInfo: "" };
  } catch (e) {
    return { totalCount: null, debugInfo: e.message };
  }
}

// --- 前端脚本 ---
const frontEndScript = `
<script>
  function updateCountdowns() {
    const now = new Date();
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const bjsTime = new Date(utcNow + (3600000 * 8));
    let targetBjs = new Date(bjsTime.getFullYear(), bjsTime.getMonth(), bjsTime.getDate(), 8, 0, 0);
    if (bjsTime.getHours() >= 8) targetBjs.setDate(targetBjs.getDate() + 1);
    const diff = targetBjs - bjsTime;
    const h = Math.floor(diff / (1000 * 60 * 60)).toString().padStart(2, '0');
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, '0');
    const s = Math.floor((diff % (1000 * 60)) / 1000).toString().padStart(2, '0');
    document.querySelectorAll('.countdown-timer').forEach(timer => {
      timer.innerHTML = h + ' 小时 ' + m + ' 分 ' + s + ' 秒';
    });
  }
  setInterval(updateCountdowns, 1000);
  updateCountdowns();
</script>
`;

// --- 生成展示卡片 UI ---
function generateCardHtml(tag, usageData, quota = 100000) {
  const safeTag = tag || "未命名节点";
  if (usageData.totalCount === null) {
    return `
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col w-full sm:w-80">
        <div class="px-5 py-4 flex justify-center items-center bg-gray-50 border-b border-gray-100">
          <h2 class="text-sm font-bold text-gray-700 truncate select-none">${safeTag}</h2>
        </div>
        <div class="p-6 flex flex-col items-center justify-center h-48">
          <div class="text-xs text-red-500 bg-red-50 px-3 py-1.5 rounded border border-red-100">${usageData.debugInfo || '未配置或 API 令牌错误'}</div>
        </div>
      </div>
    `;
  }

  const { totalCount } = usageData;
  const totalPercent = Math.min((totalCount / quota) * 100, 100).toFixed(1);

  return `
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col w-full sm:w-80">
      <div class="px-5 py-4 flex justify-center items-center bg-gray-50 border-b border-gray-100">
        <h2 class="text-sm font-bold text-gray-700 truncate select-none">${safeTag}</h2>
      </div>
      <div class="p-6 flex flex-col items-center justify-center">
        <div class="relative w-32 h-32 flex items-center justify-center">
          <svg viewBox="0 0 36 36" class="w-full h-full transform -rotate-90">
            <!-- 剩余背景 (绿色) -->
            <path class="text-emerald-400" stroke-dasharray="100, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" stroke-width="3" />
            <!-- 已用覆盖 (红色) -->
            <path class="text-red-500 transition-all duration-1000 ease-out" stroke-dasharray="${totalPercent}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" stroke-width="3" />
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="text-xl font-bold text-gray-700">${totalPercent}%</span>
          </div>
        </div>
        <div class="mt-4 text-xs text-gray-500 font-medium">总用量: <span class="text-gray-800">${totalCount.toLocaleString()}</span> / ${quota.toLocaleString()}</div>
      </div>
    </div>
  `;
}

// --- 页面大盘基础布局 ---
function buildPageLayout(title, contentHtml, isSubPage = false, globalConfig = {}, btnLogicData = []) {
  const btnTitle = globalConfig.btnTitle || '进入社区';
  const backBtnHtml = isSubPage ? `<div class="mb-6"><a href="/douding/detail" class="inline-flex items-center text-blue-600 font-medium hover:text-blue-800 transition text-sm">← 返回监控面板</a></div>` : '';
  
  const bottomActionHtml = !isSubPage ? `
    <div class="flex justify-center mt-10 w-full pt-6 border-t border-gray-200">
      <a href="#" onclick="handleCommunityBtnClick(event)" class="px-6 py-2.5 bg-white border border-gray-200 rounded-md text-gray-600 text-sm font-medium hover:bg-gray-50 flex items-center gap-2 shadow-sm transition">
        <span class="text-indigo-600">??</span> ${btnTitle}
      </a>
    </div>` : '';

  const btnLogicScript = !isSubPage ? `
    <script>
      const btnLogicData = ${JSON.stringify(btnLogicData)};
      function handleCommunityBtnClick(e) {
        e.preventDefault();
        if (!btnLogicData || btnLogicData.length === 0) return;
        
        let targetUrl = null;
        
        // 1. 查找用量未超过 90% 的节点
        for (let i = 0; i < btnLogicData.length; i++) {
          if (btnLogicData[i].percent < 90 && btnLogicData[i].link) {
            targetUrl = btnLogicData[i].link;
            break;
          }
        }
        
        // 2. 如果都超过 90%，查找未达到 100% 的节点
        if (!targetUrl) {
          for (let i = 0; i < btnLogicData.length; i++) {
            if (btnLogicData[i].percent < 100 && btnLogicData[i].link) {
              targetUrl = btnLogicData[i].link;
              break;
            }
          }
        }
        
        // 3. 所有节点都达到 100%
        if (!targetUrl) {
          alert("当日所有节点用量已达上限");
        } else {
          window.location.href = targetUrl;
        }
      }
    </script>
  ` : '';

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>${title}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", STHeiti, "Microsoft YaHei", Tahoma, Simsun, sans-serif;
          background-color: #f1f5f9;
        }
      </style>
    </head>
    <body class="min-h-screen py-8 px-4 flex justify-center items-start">
      <div class="max-w-6xl w-full">
        ${backBtnHtml}
        <div class="text-center mb-8 w-full flex flex-col items-center">
          <h1 class="text-xl md:text-2xl font-bold text-gray-800 tracking-wide mb-4 flex justify-center items-center gap-3">
            <svg class="w-6 h-6 text-indigo-800" fill="currentColor" viewBox="0 0 20 20"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"></path></svg>
            ${title}
          </h1>
          <div class="text-xs text-gray-600 font-medium bg-white border border-gray-200 inline-flex justify-center items-center px-4 py-1.5 rounded shadow-sm">
            <span>每日额度重置倒计时：</span>
            <span class="countdown-timer text-orange-500 font-bold ml-1 tracking-wider">计算中...</span>
          </div>
        </div>
        ${contentHtml}
        ${bottomActionHtml}
        <div class="text-center text-xs text-gray-400 mt-12 w-full pb-4">? 2026 美利坚合众国中央人民政府版权所有</div>
      </div>
      ${frontEndScript}
      ${btnLogicScript}
    </body>
    </html>
  `;
}

// --- API 处理逻辑 ---
async function handleGlobalApi(env) {
  const configData = JSON.parse(await env.KV.get('WORKER_CONFIG') || '[]');
  const visibleData = configData.filter(c => c.showOnHome !== false); 
  const quota = 100000;
  
  const results = await Promise.all(visibleData.map(async (item) => {
    if (!item.tag) return null;
    const usage = await fetchTotalUsage(item.userId, item.apiKey);
    return {
      tag: item.tag, count: usage.totalCount === null ? -1 : usage.totalCount,
      quota: quota, percent: usage.totalCount === null ? 0 : Number(Math.min((usage.totalCount / quota) * 100, 100).toFixed(1)),
      status: usage.totalCount === null ? 'error' : 'ok'
    };
  }));
  return new Response(JSON.stringify({ code: 200, data: results.filter(r => r !== null) }), { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
}

async function handleSpecificApi(env, targetTag) {
  const configData = JSON.parse(await env.KV.get('WORKER_CONFIG') || '[]');
  const item = configData.find(c => c.tag === targetTag);
  if (!item) return new Response(JSON.stringify({ code: 404, message: 'Tag not found' }), { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, status: 404 });
  const usage = await fetchTotalUsage(item.userId, item.apiKey);
  const data = {
    tag: item.tag, count: usage.totalCount === null ? -1 : usage.totalCount,
    quota: 100000, percent: usage.totalCount === null ? 0 : Number(Math.min((usage.totalCount / 100000) * 100, 100).toFixed(1)),
    status: usage.totalCount === null ? 'error' : 'ok'
  };
  return new Response(JSON.stringify({ code: 200, data: data }), { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
}

// --- 访问 /douding 时的智能重定向逻辑 ---
async function handleRedirectPage(env) {
  const configData = JSON.parse(await env.KV.get('WORKER_CONFIG') || '[]');
  const displayData = configData.filter(item => item.showOnHome !== false);
  
  if (displayData.length === 0) {
    const emptyHtml = `<meta charset="UTF-8"><div style="text-align:center;padding:50px;">暂无需要展示的项目，请前往 <a href="/douding/setting">配置页</a> 添加。</div>`;
    return new Response(emptyHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  const usagePromises = displayData.map(item => fetchTotalUsage(item.userId, item.apiKey));
  const usageResults = await Promise.all(usagePromises);

  let targetUrl = null;

  // 1. 查找用量未超过 90% 的节点
  for (let i = 0; i < displayData.length; i++) {
    const totalCount = usageResults[i].totalCount;
    const percent = totalCount === null ? 0 : (totalCount / 100000) * 100;
    if (percent < 90 && displayData[i].linkUrl) {
      targetUrl = displayData[i].linkUrl;
      break;
    }
  }
  
  // 2. 如果都超过 90%，查找未达到 100% 的节点
  if (!targetUrl) {
    for (let i = 0; i < displayData.length; i++) {
      const totalCount = usageResults[i].totalCount;
      const percent = totalCount === null ? 0 : (totalCount / 100000) * 100;
      if (percent < 100 && displayData[i].linkUrl) {
        targetUrl = displayData[i].linkUrl;
        break;
      }
    }
  }

  // 3. 决定跳转或提示上限
  if (targetUrl) {
    return Response.redirect(targetUrl, 302);
  } else {
    const fullHtml = `
      <meta charset="UTF-8">
      <div style="text-align:center;padding:50px;font-family:sans-serif;">
        <h3 style="color:#ef4444;">当日所有节点用量已达上限，或均未配置跳转链接。</h3>
        <a href="/douding/detail" style="color:#3b82f6;text-decoration:none;">前往查看详细用量统计 &rarr;</a>
      </div>
    `;
    return new Response(fullHtml, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
}

// --- 主页大盘逻辑 (现通过 /douding/detail 访问) ---
async function handleDisplayPage(env) {
  const configData = JSON.parse(await env.KV.get('WORKER_CONFIG') || '[]');
  const globalConfig = JSON.parse(await env.KV.get('GLOBAL_CONFIG') || '{}');
  const displayData = configData.filter(item => item.showOnHome !== false);
  
  if (displayData.length === 0) {
    const emptyHtml = `<div class="text-center py-20 text-gray-500">暂无需要展示的项目，请前往配置页添加。</div>`;
    return new Response(buildPageLayout("连接额度概览", emptyHtml, false, globalConfig), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  const usagePromises = displayData.map(item => fetchTotalUsage(item.userId, item.apiKey));
  const usageResults = await Promise.all(usagePromises);

  const resolvedCards = displayData.map((item, index) => generateCardHtml(item.tag, usageResults[index], 100000));
  
  const btnLogicData = displayData.map((item, index) => {
     const totalCount = usageResults[index].totalCount;
     const percent = totalCount === null ? 0 : (totalCount / 100000) * 100;
     return { percent: percent, link: item.linkUrl || '' };
  });

  const contentHtml = `<div class="flex flex-wrap justify-center gap-6 w-full max-w-5xl mx-auto">${resolvedCards.join('')}</div>`;
  
  return new Response(buildPageLayout("连接额度概览", contentHtml, false, globalConfig, btnLogicData), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// --- 独立单节点展示页逻辑 ---
async function handleSpecificDisplayPage(env, targetTag, hostname) {
  const configData = JSON.parse(await env.KV.get('WORKER_CONFIG') || '[]');
  const item = configData.find(c => c.tag === targetTag);
  if (!item) return Response.redirect(getMainDomainUrl(hostname), 302);
  const usage = await fetchTotalUsage(item.userId, item.apiKey);
  const cardHtml = generateCardHtml(item.tag, usage, 100000);
  
  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>${item.tag} 运行状态</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", STHeiti, "Microsoft YaHei", Tahoma, Simsun, sans-serif;
          background-color: #f1f5f9;
        }
      </style>
    </head>
    <body class="flex flex-col items-center justify-start pt-10 px-4 min-h-screen">
      <div class="w-full flex justify-center flex-grow">
        <div class="flex flex-col items-center">
          <div class="text-center mb-6">
             <div class="text-xs text-gray-600 bg-white border border-gray-200 inline-flex items-center px-4 py-1.5 rounded shadow-sm">
               每日重置倒计时：<span class="countdown-timer font-bold tracking-wider ml-1 text-orange-500">计算中...</span>
             </div>
          </div>
          ${cardHtml}
        </div>
      </div>
      <div class="text-center text-xs text-gray-400 mt-8 w-full pb-4">? 2026 美利坚合众国中央人民政府版权所有</div>
      ${frontEndScript}
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// --- 设置页逻辑 ---
async function handleSettingPage(env) {
  let data = JSON.parse(await env.KV.get('WORKER_CONFIG') || '[]');
  const globalConfig = JSON.parse(await env.KV.get('GLOBAL_CONFIG') || '{"btnTitle":"进入社区"}');

  if(data.length === 0) data.push({ id: generateId(), tag: '', userId: '', apiKey: '', linkUrl: '', showOnHome: true });

  const cardsHtml = data.map((item) => {
    const isShow = item.showOnHome !== false;
    const tagDisplay = item.tag || '未命名节点';

    return `
      <div class="node-card bg-white rounded-lg border border-gray-100 mb-3 group relative" data-id="${item.id || generateId()}">
        <div class="cursor-pointer flex justify-between items-center p-4 hover:bg-gray-50 transition node-header" onclick="toggleNode(this)">
          <div class="flex items-center space-x-2 w-1/2 overflow-hidden">
            <span class="node-title-display text-sm font-medium text-gray-700 truncate">${tagDisplay}</span>
            <span class="text-red-500 text-xs hidden-label flex-shrink-0 ${isShow ? 'hidden' : ''}">[隐藏]</span>
          </div>
          
          <div class="flex items-center space-x-3 text-gray-400" onclick="event.stopPropagation()">
            <button type="button" class="hover:text-gray-700 transition" onclick="moveUp(this)" title="向上移动"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg></button>
            <button type="button" class="hover:text-gray-700 transition" onclick="moveDown(this)" title="向下移动"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg></button>
            <button type="button" class="hover:text-orange-500 transition" onclick="toggleNode(this.closest('.node-card').querySelector('.node-header'))" title="编辑"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg></button>
            <button type="button" class="hover:text-red-500 text-red-400 transition" onclick="removeNode(this)" title="删除"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
            <svg class="w-4 h-4 transition-transform duration-200 chevron-icon cursor-pointer" onclick="toggleNode(this.closest('.node-card').querySelector('.node-header'))" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          </div>
        </div>
        
        <div class="node-content hidden p-5 bg-gray-50/50 border-t border-gray-100">
          <label class="flex items-center space-x-1.5 text-sm font-medium text-gray-600 mb-4 cursor-pointer select-none">
            <input type="checkbox" class="show-on-home-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" ${isShow ? 'checked' : ''} onchange="updateHiddenLabel(this)">
            <span>在主页展示该节点</span>
          </label>
          
          <div class="space-y-3 mb-2">
            <input type="text" name="tag" value="${item.tag}" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" oninput="updateNodeTitle(this)" />
            <input type="text" name="userId" value="${item.userId}" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
            <div class="relative w-full">
              <input type="password" name="apiKey" value="${item.apiKey}" placeholder="API 令牌 (需 Read 权限)" class="w-full px-4 py-2.5 pr-10 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
              <button type="button" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-blue-500 transition focus:outline-none" onclick="togglePassword(this)">
                <svg class="w-5 h-5 eye-closed" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path></svg>
                <svg class="w-5 h-5 eye-open hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.543 7-1.274 4.057-5.064 7-9.543 7-4.477 0-8.268-2.943-9.543-7z"></path></svg>
              </button>
            </div>
            <input type="text" name="linkUrl" value="${item.linkUrl || ''}" placeholder="节点跳转链接地址 (如 https://...)" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" />
          </div>
        </div>
      </div>
    `;
  }).join('');

  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>账户与配置管理</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", STHeiti, "Microsoft YaHei", Tahoma, Simsun, sans-serif;
          background-color: #f1f5f9;
        }
        .node-card { transform: translateZ(0); }
      </style>
    </head>
    <body class="min-h-screen py-8 px-4 flex justify-center items-start">
      <div class="w-full max-w-4xl flex flex-col min-h-full">
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 md:p-8 flex-grow">
          
          <h1 class="text-xl md:text-2xl font-bold text-gray-800 tracking-wide mb-8 flex justify-center items-center gap-3">
            <svg class="w-7 h-7 text-indigo-800" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path></svg>
            账户与配置管理
          </h1>

          <!-- 主页自定义按钮配置模块 -->
          <div class="mb-8 p-5 bg-white rounded-xl shadow-sm border border-gray-200">
            <h2 class="text-base font-bold text-gray-700 mb-4 flex items-center gap-2">
              <svg class="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
              主页底部按钮配置
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-semibold text-gray-500 mb-1">按钮标题</label>
                <input type="text" id="global-btn-title" value="${globalConfig.btnTitle || ''}" placeholder="例如: 进入社区" class="w-full px-3 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" />
              </div>
              <div class="flex items-center">
                <span class="text-xs text-gray-400 mt-5">注：按钮跳转地址已下放到下方各个节点中进行单独配置。</span>
              </div>
            </div>
          </div>

          <!-- 数据备份与迁移模块 -->
          <div class="mb-8 p-5 bg-white rounded-xl shadow-sm border border-gray-200">
            <h2 class="text-base font-bold text-gray-700 mb-4 flex items-center gap-2">
              <svg class="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
              数据备份与迁移
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="p-4 bg-gray-50 rounded-lg border border-gray-100 flex flex-col justify-between">
                 <div class="text-sm text-gray-600 mb-3">将当前所有账号配置保存至云端(KV)，或从云端记录覆盖恢复。</div>
                 <div class="flex flex-col gap-2">
                   <button type="button" onclick="createBackup()" class="w-full py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition shadow-sm">?? 立即备份当前配置</button>
                   <div class="flex gap-2">
                     <select id="backup-list" class="flex-1 px-2 py-1.5 text-xs bg-white border border-gray-300 rounded outline-none focus:border-blue-500">
                       <option value="">加载备份列表中...</option>
                     </select>
                     <button type="button" onclick="restoreBackup()" class="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-xs font-medium rounded transition">恢复</button>
                   </div>
                 </div>
              </div>
              <div class="p-4 bg-gray-50 rounded-lg border border-gray-100 flex flex-col justify-between">
                 <div class="text-sm text-gray-600 mb-3">导出配置文件到本地备份，或上传 JSON 配置文件以进行恢复。</div>
                 <div class="flex flex-col gap-2">
                   <a href="/douding/setting?action=export" download="cloudflare_accounts_backup.json" class="w-full py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-center text-sm font-medium rounded transition shadow-sm inline-block">?? 导出配置到本地</a>
                   <label class="w-full py-2 bg-orange-500 hover:bg-orange-600 text-white text-center text-sm font-medium rounded transition shadow-sm cursor-pointer block">
                     <input type="file" accept=".json" class="hidden" onchange="importFile(event)">
                     ?? 从本地文件导入
                   </label>
                 </div>
              </div>
            </div>
          </div>
          
          <form id="settings-form">
            <div id="node-list" class="space-y-3">
              ${cardsHtml}
            </div>
            
            <button type="button" id="add-node-btn" class="w-full bg-[#f97316] hover:bg-[#ea580c] text-white font-bold py-3.5 rounded-lg shadow-sm transition-colors mt-4 flex justify-center items-center gap-1">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
              添加新账户
            </button>
            
            <div class="flex justify-center items-center gap-4 mt-8 pt-6 border-t border-gray-100">
              <button type="submit" id="save-btn" class="px-5 py-2 bg-white border border-gray-200 rounded-md text-gray-600 text-sm hover:bg-gray-50 flex items-center gap-2 shadow-sm transition focus:outline-none">
                <span class="text-gray-400">??</span> 保存并应用
              </button>
              <a href="/douding/detail" class="px-5 py-2 bg-white border border-gray-200 rounded-md text-gray-600 text-sm hover:bg-gray-50 flex items-center gap-2 shadow-sm transition">
                <span class="text-orange-500">??</span> 返回用量面板
              </a>
            </div>
          </form>
        </div>
        <div class="text-center text-xs text-gray-400 mt-8 w-full pb-4">? 2026 美利坚合众国中央人民政府版权所有</div>
      </div>

      <template id="node-template">
        <div class="node-card bg-white rounded-lg border border-gray-100 mb-3 group relative" data-id="">
          <div class="cursor-pointer flex justify-between items-center p-4 hover:bg-gray-50 transition node-header" onclick="toggleNode(this)">
            <div class="flex items-center space-x-2 w-1/2 overflow-hidden">
              <span class="node-title-display text-sm font-medium text-gray-700 truncate">未命名节点</span>
              <span class="text-red-500 text-xs hidden-label flex-shrink-0 hidden">[隐藏]</span>
            </div>
            <div class="flex items-center space-x-3 text-gray-400" onclick="event.stopPropagation()">
              <button type="button" class="hover:text-gray-700 transition" onclick="moveUp(this)"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg></button>
              <button type="button" class="hover:text-gray-700 transition" onclick="moveDown(this)"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg></button>
              <button type="button" class="hover:text-orange-500 transition" onclick="toggleNode(this.closest('.node-card').querySelector('.node-header'))"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg></button>
              <button type="button" class="hover:text-red-500 text-red-400 transition" onclick="removeNode(this)"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
              <svg class="w-4 h-4 transition-transform duration-200 chevron-icon cursor-pointer rotate-180" onclick="toggleNode(this.closest('.node-card').querySelector('.node-header'))" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </div>
          </div>
          
          <div class="node-content p-5 bg-gray-50/50 border-t border-gray-100">
            <label class="flex items-center space-x-1.5 text-sm font-medium text-gray-600 mb-4 cursor-pointer select-none">
              <input type="checkbox" class="show-on-home-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" checked onchange="updateHiddenLabel(this)">
              <span>在主页展示该节点</span>
            </label>
            <div class="space-y-3 mb-2">
              <input type="text" name="tag" value="" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" oninput="updateNodeTitle(this)" />
              <input type="text" name="userId" value="" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
              <div class="relative w-full">
                <input type="password" name="apiKey" value="" placeholder="API 令牌 (需 Read 权限)" class="w-full px-4 py-2.5 pr-10 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
                <button type="button" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-blue-500 transition focus:outline-none" onclick="togglePassword(this)">
                  <svg class="w-5 h-5 eye-closed" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path></svg>
                  <svg class="w-5 h-5 eye-open hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.543 7-1.274 4.057-5.064 7-9.543 7-4.477 0-8.268-2.943-9.543-7z"></path></svg>
                </button>
              </div>
              <input type="text" name="linkUrl" value="" placeholder="节点跳转链接地址 (如 https://...)" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" />
            </div>
          </div>
        </div>
      </template>

      <script>
        async function loadBackups() {
          const select = document.getElementById('backup-list');
          try {
            const res = await fetch('/douding/setting?action=list_backups');
            const data = await res.json();
            if (data.success && data.backups.length > 0) {
              select.innerHTML = '<option value="">-- 请选择要恢复的备份 --</option>' + 
                data.backups.map(b => '<option value="' + b + '">' + b.replace('backup_', '') + '</option>').join('');
            } else {
              select.innerHTML = '<option value="">暂无云端备份</option>';
            }
          } catch (e) {
            select.innerHTML = '<option value="">加载失败</option>';
          }
        }

        async function createBackup() {
          if(!confirm('确定要将当前的配置信息备份到云端(KV)吗？')) return;
          try {
            const res = await fetch('/douding/setting?action=backup', { method: 'POST' });
            if (res.ok) {
              alert('备份成功！');
              loadBackups();
            } else alert('备份失败，请检查网络或 KV 绑定');
          } catch(e) { alert('请求异常'); }
        }

        async function restoreBackup() {
          const key = document.getElementById('backup-list').value;
          if(!key) return alert('请先选择一个历史备份');
          if(!confirm('【警告】从云端恢复将覆盖当前的全部配置数据！是否继续？')) return;
          
          try {
            const res = await fetch('/douding/setting?action=restore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key })
            });
            if(res.ok) {
              alert('恢复成功！页面将自动刷新。');
              location.reload();
            } else alert('恢复失败');
          } catch(e) { alert('请求异常'); }
        }

        async function importFile(event) {
          const file = event.target.files[0];
          if(!file) return;
          if(!confirm('【警告】导入本地文件将覆盖当前的全部配置数据！是否继续？')) {
            event.target.value = '';
            return;
          }
          
          const reader = new FileReader();
          reader.onload = async function(e) {
            try {
              const content = JSON.parse(e.target.result);
              const res = await fetch('/douding/setting?action=import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(content)
              });
              
              if(res.ok) {
                alert('导入成功！页面将自动刷新。');
                location.reload();
              } else {
                alert('导入失败，请检查文件内容是否正确。');
              }
            } catch(err) {
              alert('文件解析失败，请确保上传的是有效的 JSON 配置文件。');
            }
            event.target.value = '';
          };
          reader.readAsText(file);
        }

        loadBackups();

        function moveUp(btn) {
          const current = btn.closest('.node-card');
          const prev = current.previousElementSibling;
          if (prev) {
            current.parentNode.insertBefore(current, prev);
          }
        }

        function moveDown(btn) {
          const current = btn.closest('.node-card');
          const next = current.nextElementSibling;
          if (next) {
            current.parentNode.insertBefore(next, current);
          }
        }

        function togglePassword(btn) {
          const container = btn.closest('.relative');
          const input = container.querySelector('input[name="apiKey"]');
          const iconClosed = btn.querySelector('.eye-closed');
          const iconOpen = btn.querySelector('.eye-open');
          
          if (input.type === 'password') {
            input.type = 'text';
            iconClosed.classList.add('hidden');
            iconOpen.classList.remove('hidden');
          } else {
            input.type = 'password';
            iconClosed.classList.remove('hidden');
            iconOpen.classList.add('hidden');
          }
        }

        function removeNode(btn) {
          const card = btn.closest('.node-card');
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 200);
        }

        function toggleNode(headerElement) {
          const content = headerElement.nextElementSibling;
          const icon = headerElement.querySelector('.chevron-icon');
          if (content.classList.contains('hidden')) {
            content.classList.remove('hidden');
            icon.classList.add('rotate-180');
          } else {
            content.classList.add('hidden');
            icon.classList.remove('rotate-180');
          }
        }

        function updateNodeTitle(inputElement) {
          const titleSpan = inputElement.closest('.node-card').querySelector('.node-title-display');
          if (titleSpan) {
            titleSpan.textContent = inputElement.value || '未命名节点';
          }
        }

        function updateHiddenLabel(checkbox) {
          const label = checkbox.closest('.node-card').querySelector('.hidden-label');
          if (checkbox.checked) {
            label.classList.add('hidden');
          } else {
            label.classList.remove('hidden');
          }
        }

        document.getElementById('add-node-btn').addEventListener('click', () => {
          const template = document.getElementById('node-template').content.cloneNode(true);
          const newCard = template.querySelector('.node-card');
          newCard.dataset.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
          document.getElementById('node-list').appendChild(newCard);
        });

        document.getElementById('settings-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('save-btn');
          btn.innerHTML = '<span class="animate-spin mr-1">?</span> 保存中...';
          btn.disabled = true;

          const btnTitle = document.getElementById('global-btn-title').value.trim() || '进入社区';
          
          const cards = document.querySelectorAll('.node-card');
          const configArray = [];
          
          cards.forEach(card => {
            const id = card.dataset.id;
            const tag = card.querySelector('[name="tag"]').value;
            const userId = card.querySelector('[name="userId"]').value;
            const apiKey = card.querySelector('[name="apiKey"]').value;
            const linkUrl = card.querySelector('[name="linkUrl"]').value.trim();
            const showOnHome = card.querySelector('.show-on-home-checkbox').checked;
            
            configArray.push({ id, tag, userId, apiKey, linkUrl, showOnHome });
          });

          const payload = {
            global: { btnTitle },
            nodes: configArray
          };

          try {
            const res = await fetch('/douding/setting', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if(res.ok) window.location.href = '/douding/detail';
            else alert('保存失败，请检查网络');
          } catch(err) {
            alert('保存异常');
          }
          btn.disabled = false;
        });
      </script>
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

async function handleSaveSettings(request, env) {
  const payload = await request.json();
  
  if (Array.isArray(payload)) {
    await env.KV.put('WORKER_CONFIG', JSON.stringify(payload));
  } else {
    await env.KV.put('WORKER_CONFIG', JSON.stringify(payload.nodes || []));
    await env.KV.put('GLOBAL_CONFIG', JSON.stringify(payload.global || {}));
  }
  
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

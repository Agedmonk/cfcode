export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.KV_DATA) {
        throw new Error("KV_DATA 未绑定。请检查 Cloudflare Worker 环境变量配置。");
      }

      const url = new URL(request.url);
      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      
      const hostname = url.hostname;
      const segments = path.split('/').filter(Boolean);

      if (segments[0] !== 'NicholasLai') {
        return Response.redirect(getMainDomainUrl(hostname), 302);
      }

      // 1. 监控概览面板
      if (segments.length === 1) return await handleDisplayPage(env);

      // 2. 二级路径
      if (segments.length === 2) {
        const route = segments[1];
        if (route === 'setting') {
          if (request.method === 'POST') return await handleSaveSettings(request, env);
          return await handleSettingPage(env);
        }
        if (route === 'api') return await handleGlobalApi(env);
        
        const tag = decodeURIComponent(route);
        return await handleSpecificDisplayPage(env, tag, hostname);
      }

      // 3. 三级路径 API
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

// --- 工具函数与底层逻辑 ---

function getMainDomainUrl(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 3) {
    const rootDomain = parts.slice(-2).join('.');
    return `https://www.${rootDomain}`;
  }
  return `https://www.${hostname}`;
}

// 自动拉取 Cloudflare REST API 获取真实项目名
async function fetchProjectMap(accountId, apiToken) {
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json'
  };
  const map = {};

  const fetchAll = async (baseUrl) => {
    let page = 1;
    let all = [];
    while (true) {
      try {
        const res = await fetch(`${baseUrl}&page=${page}`, { headers });
        if (!res.ok) break;
        const data = await res.json();
        const results = data.result || [];
        all = all.concat(results);
        const info = data.result_info;
        if (info && info.page < info.total_pages) {
          page++;
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }
    return all;
  };

  try {
    const [wList, pList] = await Promise.all([
      fetchAll(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts?per_page=50`),
      fetchAll(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?per_page=50`)
    ]);

    wList.forEach(w => {
      const id = w.id || w.script || w.name;
      const name = w.name || w.script || w.id;
      if (id) map[String(id)] = String(name);
      if (name) map[String(name)] = String(name);
    });

    pList.forEach(p => {
      const id = p.id || p.project_id || p.uid;
      const name = p.name || p.project_name || p.slug;
      const slug = p.slug || p.name;
      if (id) map[String(id)] = String(name);
      if (slug) map[String(slug)] = String(name);
      if (name) map[String(name)] = String(name);
    });
  } catch (e) {
    console.error("拉取项目列表失败:", e);
  }
  return map;
}

// 智能清洗长 ID 并适配别名
function resolveProjectName(rawName, projectMap, aliasMap) {
  if (!rawName) return "未知项目";
  
  if (aliasMap && aliasMap[rawName]) return aliasMap[rawName];
  
  const nameStr = String(rawName);

  if (projectMap) {
    if (projectMap[nameStr]) return projectMap[nameStr];
    
    const m = nameStr.match(/(\d{4,})/);
    if (m && projectMap[m[1]]) {
      let envLabel = nameStr.endsWith('-preview') ? " (预览)" : (nameStr.endsWith('-production') ? " (生产)" : "");
      return projectMap[m[1]] + envLabel;
    }

    if (nameStr.includes('--')) {
      const parts = nameStr.split('--');
      let slugWithEnv = parts[parts.length - 1]; 
      let cleanSlug = slugWithEnv;
      let envLabel = "";
      
      if (cleanSlug.endsWith('-production')) {
          cleanSlug = cleanSlug.replace('-production', '');
          envLabel = " (生产)";
      } else if (cleanSlug.endsWith('-preview')) {
          cleanSlug = cleanSlug.replace('-preview', '');
          envLabel = " (预览)";
      }
      
      if (projectMap[cleanSlug]) return projectMap[cleanSlug] + envLabel;
    }
  }

  let cleaned = nameStr;
  if (cleaned.startsWith('pages-worker--')) {
    cleaned = cleaned.replace('pages-worker--', '');
    let envLabel = "";
    if (cleaned.endsWith('-production')) {
      cleaned = cleaned.replace('-production', '');
      envLabel = " (生产)";
    } else if (cleaned.endsWith('-preview')) {
      cleaned = cleaned.replace('-preview', '');
      envLabel = " (预览)";
    }
    return cleaned + envLabel;
  }

  return nameStr;
}

// 核心查询逻辑：重构为根据 dimension 全局聚合分组提取
async function fetchWorkerUsageCount(userId, apiKey, aliasMap = {}) {
  const defaultReturn = { workerCount: null, pagesCount: null, totalCount: null, workersDetails: [], pagesDetails: [], debugInfo: "" };
  if (!userId || !apiKey) return defaultReturn;

  const now = new Date();
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const endTimeUtc = now.toISOString();

  const fetchGQL = async (q) => {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query: q })
      });
      return await res.json();
    } catch (e) {
      return { errors: [{ message: e.message }] };
    }
  };

  // 1. 使用 GraphQL 的 dimensions 字段，一次性无视名称过滤拉取所有列表
  const queryAdaptive = `
    query {
      viewer {
        accounts(filter: {accountTag: "${userId}"}) {
          workers: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}"}) {
            dimensions { scriptName }
            sum { requests }
          }
          pages: pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}"}) {
            dimensions { projectName }
            sum { requests }
          }
        }
      }
    }
  `;

  let debugErrors = [];
  
  let [resGQL, projectMap] = await Promise.all([
    fetchGQL(queryAdaptive),
    fetchProjectMap(userId, apiKey)
  ]);

  // 2. 智能降级：如果高级接口报错，降级使用基础接口
  if (resGQL.errors || !resGQL.data) {
    debugErrors.push("Adaptive 接口受限，已降级");
    const queryBasic = `
      query {
        viewer {
          accounts(filter: {accountTag: "${userId}"}) {
            workers: workersInvocationsGroups(limit: 10000, filter: {datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}"}) {
              dimensions { scriptName }
              sum { requests }
            }
          }
        }
      }
    `;
    resGQL = await fetchGQL(queryBasic);
    if (resGQL.errors || !resGQL.data) {
       return { ...defaultReturn, debugInfo: "GraphQL 查询完全失败: " + (resGQL.errors?.[0]?.message || 'Unknown') };
    }
  }

  const acc = resGQL.data.viewer?.accounts?.[0];
  if (!acc) return { ...defaultReturn, debugInfo: "无可用的账户数据" };

  let workersData = acc.workers || [];
  let pagesData = acc.pages || [];

  let workersDetails = [];
  let pagesDetails = [];
  let workerCount = 0;
  let pagesCount = 0;
  const processedPages = new Set();

  // 3. 在本地基于返回的分组数组进行清洗、聚合与总数计算
  if (pagesData.length > 0) {
    pagesData.forEach(d => {
      const raw = d?.dimensions?.projectName || '未知_Pages';
      const reqs = d?.sum?.requests || 0;
      if (reqs > 0) {
        processedPages.add(raw);
        pagesCount += reqs;
        pagesDetails.push({ rawName: raw, name: resolveProjectName(raw, projectMap, aliasMap), count: reqs });
      }
    });
  }

  if (workersData.length > 0) {
    workersData.forEach(d => {
      const raw = d?.dimensions?.scriptName || '未知_Worker';
      const reqs = d?.sum?.requests || 0;
      if (reqs > 0) {
        if (raw.startsWith('pages-worker--')) {
          // 处理伪装为 Worker 的 Pages 请求
          if (!processedPages.has(raw)) {
             processedPages.add(raw);
             pagesCount += reqs;
             pagesDetails.push({ rawName: raw, name: resolveProjectName(raw, projectMap, aliasMap), count: reqs });
          }
        } else {
          workerCount += reqs;
          workersDetails.push({ rawName: raw, name: resolveProjectName(raw, projectMap, aliasMap), count: reqs });
        }
      }
    });
  }

  workersDetails.sort((a, b) => b.count - a.count);
  pagesDetails.sort((a, b) => b.count - a.count);
  const totalCount = workerCount + pagesCount;

  return { workerCount, pagesCount, totalCount, workersDetails, pagesDetails, debugInfo: debugErrors.join(" | ") || "OK" };
}

// --- 前端脚本 ---
const frontEndScript = `
<script>
  function toggleModule(element) {
    const content = element.parentElement.querySelector('.module-content');
    const icon = element.querySelector('svg');
    if (content.classList.contains('hidden')) {
      content.classList.remove('hidden');
      icon.classList.add('rotate-180');
    } else {
      content.classList.add('hidden');
      icon.classList.remove('rotate-180');
    }
  }

  function updateCountdowns() {
    const now = new Date();
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const bjsTime = new Date(utcNow + (3600000 * 8));

    let targetBjs = new Date(bjsTime.getFullYear(), bjsTime.getMonth(), bjsTime.getDate(), 8, 0, 0);
    if (bjsTime.getHours() >= 8) {
      targetBjs.setDate(targetBjs.getDate() + 1);
    }

    const diff = targetBjs - bjsTime;
    const h = Math.floor(diff / (1000 * 60 * 60)).toString().padStart(2, '0');
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, '0');
    const s = Math.floor((diff % (1000 * 60)) / 1000).toString().padStart(2, '0');

    const timers = document.querySelectorAll('.countdown-timer');
    timers.forEach(timer => {
      timer.innerHTML = h + ' 小时 ' + m + ' 分 ' + s + ' 秒';
    });
  }
  setInterval(updateCountdowns, 1000);
  updateCountdowns();
</script>
`;

// 生成展示卡片 UI
function generateCardHtml(tag, usageData, quota = 100000) {
  const safeTag = tag || "未命名节点";
  
  if (usageData.totalCount === null) {
    return `
      <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex flex-col justify-center items-center text-center">
        <h2 class="text-lg font-bold text-gray-800 mb-4 w-full truncate">${safeTag}</h2>
        <div class="text-sm text-red-500 bg-red-50 px-3 py-1 rounded-full border border-red-100">未配置或 API 令牌错误</div>
      </div>
    `;
  }

  const { workerCount, pagesCount, totalCount, workersDetails = [], pagesDetails = [], debugInfo } = usageData;
  const totalPercent = Math.min((totalCount / quota) * 100, 100).toFixed(1);
  const workerPercent = totalCount === 0 ? 0 : ((workerCount / quota) * 100).toFixed(1);
  const pagesPercent = totalCount === 0 ? 0 : ((pagesCount / quota) * 100).toFixed(1);

  const workersHtml = workersDetails.map(w => `
    <div class="flex justify-between items-center bg-gray-50 hover:bg-gray-100 px-3 py-2 rounded-lg transition">
      <div class="flex items-center space-x-2 w-2/3">
        <span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></span>
        <span class="text-xs text-gray-700 truncate cursor-help" title="原始 ID: ${w.rawName}">${w.name}</span>
      </div>
      <span class="text-xs font-semibold text-emerald-700 font-mono w-1/3 text-right">${w.count.toLocaleString()}</span>
    </div>
  `).join('');

  const pagesHtml = pagesDetails.map(p => `
    <div class="flex justify-between items-center bg-gray-50 hover:bg-gray-100 px-3 py-2 rounded-lg transition">
      <div class="flex items-center space-x-2 w-2/3">
        <span class="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"></span>
        <span class="text-xs text-gray-700 truncate cursor-help" title="原始 ID: ${p.rawName}">${p.name}</span>
      </div>
      <span class="text-xs font-semibold text-blue-700 font-mono w-1/3 text-right">${p.count.toLocaleString()}</span>
    </div>
  `).join('');

  let detailsHtml = '';
  
  if (workersDetails.length > 0 || pagesDetails.length > 0) {
    detailsHtml = `
      <div class="mt-2 pt-4 border-t border-gray-100">
        <h4 class="text-xs font-bold text-gray-500 mb-3 px-1 flex justify-between items-center">
          <span>📊 节点项目流量明细 (Top)</span>
        </h4>
        <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
          ${workersHtml}
          ${pagesHtml}
        </div>
      </div>
    `;
  } else if (totalCount > 0) {
    // 优雅容错：有总量但查不到明细时，温柔提示而非粗暴报错
    detailsHtml = `
      <div class="mt-2 pt-4 border-t border-gray-100 text-center">
        <span class="text-xs text-orange-600 bg-orange-50 px-3 py-1.5 rounded-md border border-orange-100 inline-block w-full">
          ⚠️ 当前 API 令牌权限受限，无法拉取项目明细
        </span>
      </div>
    `;
  } else {
    detailsHtml = `
      <div class="mt-2 pt-4 border-t border-gray-100 text-center">
        <span class="text-xs text-gray-400">当前账号暂无流量产生</span>
      </div>
    `;
  }

  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col">
      <div class="px-5 py-4 cursor-pointer flex justify-between items-center bg-gray-50 hover:bg-gray-100 transition" onclick="toggleModule(this)">
        <h2 class="text-md font-bold text-gray-800 truncate select-none">${safeTag} 详细使用状态</h2>
        <svg class="w-5 h-5 text-gray-400 transform transition-transform duration-300" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </div>

      <div class="px-5 py-4">
        <div class="w-full bg-gray-100 rounded-full h-7 relative overflow-hidden shadow-inner flex">
          <div class="h-full bg-emerald-500 transition-all duration-500" style="width: ${workerPercent}%;" title="Workers: ${workerCount}"></div>
          <div class="h-full bg-blue-500 transition-all duration-500" style="width: ${pagesPercent}%;" title="Pages: ${pagesCount}"></div>
          <div class="absolute inset-0 flex items-center justify-center text-xs font-bold tracking-wide ${totalPercent > 50 ? 'text-white drop-shadow-md' : 'text-gray-700'}">
            ${totalPercent}%
          </div>
        </div>
      </div>

      <div class="module-content hidden px-5 pb-5 border-t border-gray-100 pt-4">
        <div class="grid grid-cols-2 gap-3 text-center">
          <div class="p-2 bg-emerald-50 rounded-lg border border-emerald-100">
            <div class="text-[10px] text-emerald-600 mb-1 font-medium">Workers 汇总</div>
            <div class="text-sm font-bold text-emerald-700">${workerCount.toLocaleString()}</div>
          </div>
          <div class="p-2 bg-blue-50 rounded-lg border border-blue-100">
            <div class="text-[10px] text-blue-600 mb-1 font-medium">Pages 汇总</div>
            <div class="text-sm font-bold text-blue-700">${pagesCount.toLocaleString()}</div>
          </div>
          <div class="p-2 bg-gray-50 rounded-lg border border-gray-200">
            <div class="text-[10px] text-gray-600 mb-1 font-medium">今日合计请求</div>
            <div class="text-sm font-bold text-gray-700">${totalCount.toLocaleString()}</div>
          </div>
          <div class="p-2 bg-orange-50 rounded-lg border border-orange-100">
            <div class="text-[10px] text-orange-600 mb-1 font-medium">系统日配额</div>
            <div class="text-sm font-bold text-orange-700">${quota.toLocaleString()}</div>
          </div>
        </div>
        ${detailsHtml}
      </div>
    </div>
  `;
}

// 页面大盘基础布局
function buildPageLayout(title, contentHtml, isSubPage = false) {
  const backBtnHtml = isSubPage 
    ? `<div class="mb-6"><a href="/NicholasLai" class="inline-flex items-center text-blue-600 font-medium hover:text-blue-800 transition">← 返回监控面板</a></div>` 
    : '';
    
  const bottomActionHtml = !isSubPage 
    ? `<div class="flex justify-center mt-12 w-full"><a href="/NicholasLai/setting" class="w-full md:w-64 bg-gray-800 text-white text-center font-bold py-4 rounded-full shadow-lg hover:bg-gray-700 transition">⚙️ 账号与授权配置</a></div>` 
    : '';

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>${title}监控系统</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f3f4f6; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
      </style>
    </head>
    <body class="bg-gray-100 min-h-screen py-10 px-4">
      <div class="max-w-5xl mx-auto w-full">
        ${backBtnHtml}
        <div class="text-center mb-10 w-full flex flex-col items-center">
          <h1 class="text-3xl md:text-4xl font-extrabold text-gray-800 tracking-tight mb-4 break-words px-2">${title}</h1>
          <div class="text-sm md:text-base text-gray-600 font-medium bg-white border border-gray-200 inline-flex flex-wrap justify-center items-center px-6 py-2.5 rounded-full shadow-sm">
            <span class="mr-2">⏱️</span>
            <span>每日额度重置倒计时：</span>
            <span class="countdown-timer text-blue-600 font-bold ml-1 tracking-wider">计算中...</span>
          </div>
        </div>
        ${contentHtml}
        ${bottomActionHtml}
      </div>
      ${frontEndScript}
    </body>
    </html>
  `;
}

// --- API 处理逻辑 ---

async function handleGlobalApi(env) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const quota = 100000;
  
  const results = await Promise.all(configData.map(async (item) => {
    if (!item.tag) return null;
    const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
    return {
      tag: item.tag,
      count: usage.totalCount === null ? -1 : usage.totalCount,
      workerCount: usage.workerCount === null ? -1 : usage.workerCount,
      pagesCount: usage.pagesCount === null ? -1 : usage.pagesCount,
      workersDetails: usage.workersDetails || [],
      pagesDetails: usage.pagesDetails || [],
      quota: quota,
      percent: usage.totalCount === null ? 0 : Number(Math.min((usage.totalCount / quota) * 100, 100).toFixed(1)),
      status: usage.totalCount === null ? 'error' : 'ok'
    };
  }));

  const cleanResults = results.filter(r => r !== null);
  return new Response(JSON.stringify({ code: 200, data: cleanResults }), { 
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } 
  });
}

async function handleSpecificApi(env, targetTag) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const quota = 100000;
  
  const item = configData.find(c => c.tag === targetTag);
  if (!item) {
    return new Response(JSON.stringify({ code: 404, message: 'Tag not found' }), { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, status: 404 });
  }

  const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
  const data = {
    tag: item.tag,
    count: usage.totalCount === null ? -1 : usage.totalCount,
    workerCount: usage.workerCount === null ? -1 : usage.workerCount,
    pagesCount: usage.pagesCount === null ? -1 : usage.pagesCount,
    workersDetails: usage.workersDetails || [],
    pagesDetails: usage.pagesDetails || [],
    quota: quota,
    percent: usage.totalCount === null ? 0 : Number(Math.min((usage.totalCount / quota) * 100, 100).toFixed(1)),
    status: usage.totalCount === null ? 'error' : 'ok'
  };

  return new Response(JSON.stringify({ code: 200, data: data }), { 
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } 
  });
}

// --- 页面渲染逻辑 ---

async function handleDisplayPage(env) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const cardsHtmlPromise = configData.map(async (item) => {
    const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
    return generateCardHtml(item.tag, usage, 100000);
  });
  
  const resolvedCards = await Promise.all(cardsHtmlPromise);
  const contentHtml = `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full">${resolvedCards.join('')}</div>`;
  
  const html = buildPageLayout("Workers & Pages 流量概览", contentHtml, false);
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

async function handleSpecificDisplayPage(env, targetTag, hostname) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const item = configData.find(c => c.tag === targetTag);
  
  if (!item) {
    return Response.redirect(getMainDomainUrl(hostname), 302);
  }

  const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
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
        html, body { height: 100%; margin: 0; background-color: transparent; }
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f3f4f6; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
      </style>
    </head>
    <body class="flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-4">
           <div class="text-xs text-gray-500 bg-white border border-gray-200 inline-flex items-center px-4 py-1.5 rounded-full shadow-sm">
             每日额度重置倒计时：<span class="countdown-timer font-bold tracking-wider ml-1">计算中...</span>
           </div>
        </div>
        ${cardHtml}
      </div>
      ${frontEndScript}
    </body>
    </html>
  `;
  
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// --- 设置页逻辑：上下堆叠式排版 + 流量对照徽章 ---
async function handleSettingPage(env) {
  let data = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  while (data.length < 6) data.push({ tag: '', userId: '', apiKey: '', aliases: {} });

  // 扫描以获取真实的流量 ID
  const usagePromises = data.map(item => {
    if (item.userId && item.apiKey) {
      return fetchWorkerUsageCount(item.userId, item.apiKey, {}); // 传入空别名强制获取原始名
    }
    return Promise.resolve(null);
  });
  const usages = await Promise.all(usagePromises);

  const cardsHtml = data.map((item, i) => {
    const u = usages[i];
    const existingAliases = item.aliases || {};
    
    const rawNames = new Set(Object.keys(existingAliases));
    const countMap = {};

    if (u) {
      u.workersDetails.forEach(d => {
          rawNames.add(d.rawName);
          countMap[d.rawName] = d.count;
      });
      u.pagesDetails.forEach(d => {
          rawNames.add(d.rawName);
          countMap[d.rawName] = d.count;
      });
    }

    let aliasRowsHtml = Array.from(rawNames).map(rawName => {
      const safeRaw = encodeURIComponent(rawName);
      const currentAlias = existingAliases[rawName] || '';
      
      // 提取该 ID 今天产生的请求量，辅助用户对照辨认
      const reqCount = countMap[rawName];
      const reqBadge = reqCount !== undefined 
        ? `<span class="bg-blue-50 text-blue-600 text-[10px] px-1.5 py-0.5 rounded border border-blue-100 font-mono tracking-tight whitespace-nowrap" title="今日请求量">${reqCount.toLocaleString()} 次</span>` 
        : `<span class="bg-gray-50 text-gray-400 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 font-mono tracking-tight whitespace-nowrap" title="今日暂无流量">无流量</span>`;

      // 上下两行堆叠设计：彻底解决原始名被截断的问题
      return `
        <div class="flex flex-col bg-white p-3 rounded-lg border border-gray-200 hover:border-blue-300 transition shadow-sm mb-3">
          <div class="flex justify-between items-start mb-2 gap-2">
            <span class="text-xs font-mono text-gray-600 break-all leading-relaxed">
              <span class="text-gray-400 select-none">原始 ID:</span> <strong>${rawName}</strong>
            </span>
            <div class="flex-shrink-0 mt-0.5">${reqBadge}</div>
          </div>
          <div class="flex items-center">
            <span class="text-gray-300 mr-2 select-none">↳</span>
            <input type="text" name="alias_${i}_${safeRaw}" value="${currentAlias}" placeholder="输入自定义显示名称 (留空则显示原始 ID)" class="w-full px-2 py-1.5 rounded-md text-xs bg-gray-50 border border-gray-200 focus:bg-white focus:ring-1 focus:ring-blue-500 outline-none transition" />
          </div>
        </div>
      `;
    }).join('');

    if (aliasRowsHtml === '') {
      aliasRowsHtml = `<div class="text-xs text-gray-400 text-center py-5 bg-white rounded-lg border border-dashed border-gray-200">填写上方账号并保存后，系统将自动雷达扫描流量项目。</div>`;
    }

    return `
      <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200 mb-6 w-full">
        <h3 class="text-md font-bold text-gray-800 mb-4 border-b pb-2">📍 节点配置卡片 ${i + 1}</h3>
        
        <div class="space-y-4 mb-6">
          <input type="text" name="tag_${i}" value="${item.tag}" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-3 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition" />
          <input type="text" name="userId_${i}" value="${item.userId}" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-3 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition" />
          <input type="password" name="apiKey_${i}" value="${item.apiKey}" placeholder="API 令牌 (需 Account Analytics: Read 权限)" class="w-full px-4 py-3 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition" />
        </div>

        <div class="bg-gray-50 rounded-lg p-4 border border-gray-100">
          <h4 class="text-xs font-bold text-gray-600 mb-3">🏷️ 本节点项目别名配置 (自动扫描)</h4>
          <div class="max-h-64 overflow-y-auto custom-scrollbar pr-1">
            ${aliasRowsHtml}
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
      <title>参数配置 - 监控中心</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f3f4f6; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
      </style>
    </head>
    <body class="bg-gray-100 min-h-screen py-10 px-4">
      <form method="POST" action="/NicholasLai/setting" class="max-w-2xl mx-auto w-full relative">
        <div class="flex justify-between items-center mb-8 w-full bg-white p-4 rounded-xl shadow-sm border border-gray-200">
          <h1 class="text-xl md:text-2xl font-bold text-gray-800 tracking-tight">授权与别名配置</h1>
          <a href="/NicholasLai" class="text-blue-600 font-medium hover:text-blue-800 transition">← 返回概览面板</a>
        </div>
        
        ${cardsHtml}
        
        <button type="submit" class="w-full bg-blue-600 text-white font-bold py-4 rounded-xl shadow-md hover:bg-blue-700 hover:shadow-lg transition-all mt-4 sticky bottom-6 z-10">
          💾 保存所有配置与别名
        </button>
      </form>
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

async function handleSaveSettings(request, env) {
  const formData = await request.formData();
  const newData = [];
  
  for (let i = 0; i < 6; i++) {
    const aliases = {};
    const prefix = `alias_${i}_`;
    
    for (const [key, value] of formData.entries()) {
      if (key.startsWith(prefix)) {
        const rawName = decodeURIComponent(key.substring(prefix.length));
        const trimmedVal = value.trim();
        if (trimmedVal !== '') {
          aliases[rawName] = trimmedVal;
        }
      }
    }

    newData.push({
      tag: formData.get(`tag_${i}`) || '',
      userId: formData.get(`userId_${i}`) || '',
      apiKey: formData.get(`apiKey_${i}`) || '',
      aliases: aliases
    });
  }
  
  await env.KV_DATA.put('WORKER_CONFIG', JSON.stringify(newData));
  return Response.redirect(new URL(request.url).origin + '/NicholasLai', 302);
}

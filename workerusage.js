export default {
  async fetch(request, env, _ctx) {
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

      if (segments.length === 1) return await handleDisplayPage(env);
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

// ==================== 工具函数 ====================
function getMainDomainUrl(hostname) {
  return `https://${hostname}/NicholasLai`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function resolveProjectName(rawName, projectMap, aliasMap) {
  if (!rawName) return "未知项目";
  if (aliasMap && aliasMap[rawName]) return aliasMap[rawName];
  const nameStr = String(rawName);
  if (projectMap) {
    if (projectMap[nameStr]) return projectMap[nameStr];
    const m = nameStr.match(/(\d{4,})/);
    if (m && projectMap[m[1]]) {
      const envLabel = nameStr.endsWith('-preview') ? " (预览)" : (nameStr.endsWith('-production') ? " (生产)" : "");
      return projectMap[m[1]] + envLabel;
    }
    if (nameStr.includes('--')) {
      const parts = nameStr.split('--');
      let cleanSlug = parts[parts.length - 1];
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

// ==================== 独立函数1：处理 Workers ====================
async function fetchWorkerProjectsUsage(userId, apiKey, aliasMap = {}) {
  const defaultResult = { count: 0, details: [], debugInfo: "" };
  if (!userId || !apiKey) return defaultResult;

  const now = new Date();
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const endTimeUtc = now.toISOString();

  const fetchGQL = async (query) => {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query })
      });
      return await res.json();
    } catch (e) {
      return { errors: [{ message: e.message }] };
    }
  };

  const debugErrors = [];
  const workerList = await fetchWorkerList(userId, apiKey);
  
  let workersAggregated = [];
  const aggQuery = `
    query { viewer { accounts(filter: {accountTag: "${userId}"}) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}" }) {
        dimensions { scriptName } sum { requests }
      }
    }}}
  `;
  const aggResult = await fetchGQL(aggQuery);
  if (!aggResult.errors && aggResult.data) {
    workersAggregated = aggResult.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  } else {
    debugErrors.push("Worker 聚合用量查询失败");
  }

  const usageMap = new Map();
  for (const row of workersAggregated) {
    const scriptName = row?.dimensions?.scriptName;
    if (scriptName) usageMap.set(String(scriptName), (usageMap.get(String(scriptName)) || 0) + (row?.sum?.requests || 0));
  }

  const details = [];
  const displaySeen = new Set();

  for (const project of workerList) {
    const scriptName = project.name;
    if (String(scriptName).startsWith('pages-worker--')) continue;
    const displayName = resolveProjectName(scriptName, { [project.id]: scriptName, [scriptName]: scriptName }, aliasMap);
    const count = usageMap.get(scriptName) || 0;
    if (!displaySeen.has(displayName)) {
      displaySeen.add(displayName);
      details.push({ rawName: scriptName, name: displayName, count });
    }
  }

  for (const [scriptName, count] of usageMap) {
    if (count > 0 && !String(scriptName).startsWith('pages-worker--')) {
      const displayName = resolveProjectName(scriptName, {}, aliasMap);
      if (!displaySeen.has(displayName)) {
        displaySeen.add(displayName);
        details.push({ rawName: scriptName, name: displayName, count });
      }
    }
  }

  details.sort((a, b) => b.count - a.count);
  const totalCount = details.reduce((sum, d) => sum + d.count, 0);
  if (totalCount > 0 && details.length === 0) debugErrors.push("检测到 Worker 用量，但无法获取项目列表");

  return { count: totalCount, details, debugInfo: debugErrors.join(" | ") };
}

async function fetchWorkerList(accountId, apiToken) {
  const headers = { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  let page = 1;
  const all = [];
  while (true) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts?per_page=50&page=${page}`, { headers });
      if (!res.ok) break;
      const data = await res.json();
      all.push(...(data.result || []));
      const info = data.result_info;
      if (info && info.page < info.total_pages) page++;
      else break;
    } catch (e) { break; }
  }
  return all.map(w => ({ id: String(w.id || w.script || w.name || ''), name: String(w.name || w.script || w.id || '') })).filter(x => x.id && x.name);
}

// ==================== 独立函数2：处理 Pages ====================
async function fetchPagesProjectsUsage(userId, apiKey, aliasMap = {}) {
  const defaultResult = { count: 0, details: [], debugInfo: "" };
  if (!userId || !apiKey) return defaultResult;

  const now = new Date();
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const endTimeUtc = now.toISOString();

  const fetchGQL = async (query) => {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query })
      });
      return await res.json();
    } catch (e) { return { errors: [{ message: e.message }] }; }
  };

  const debugErrors = [];
  const pagesList = await fetchPagesList(userId, apiKey);
  
  let pagesData = [];
  let result = await fetchGQL(`
    query { viewer { accounts(filter: {accountTag: "${userId}"}) {
      details: pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}" }) {
        dimensions { projectName } sum { requests }
      }
    }}}
  `);
  if (!result.errors && result.data?.viewer?.accounts?.[0]?.details) {
    pagesData = result.data.viewer.accounts[0].details;
  } else {
    result = await fetchGQL(`
      query { viewer { accounts(filter: {accountTag: "${userId}"}) {
        details: pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: "${startOfTodayUtc}", datetime_leq: "${endTimeUtc}" }) {
          dimensions { scriptName } sum { requests }
        }
      }}}
    `);
    if (!result.errors && result.data?.viewer?.accounts?.[0]?.details) pagesData = result.data.viewer.accounts[0].details;
    else debugErrors.push("Pages 聚合用量查询失败");
  }

  const usageMap = new Map();
  for (const row of pagesData) {
    const rawName = row?.dimensions?.projectName || row?.dimensions?.scriptName;
    if (rawName) usageMap.set(String(rawName), (usageMap.get(String(rawName)) || 0) + (row?.sum?.requests || 0));
  }

  const details = [];
  const displaySeen = new Set();

  for (const project of pagesList) {
    const candidates = [String(project.name), String(project.slug), String(project.id)];
    let count = 0, matchedRaw = candidates[0];
    for (const candidate of candidates) {
      if (usageMap.has(candidate)) { count = usageMap.get(candidate); matchedRaw = candidate; break; }
    }
    const displayName = resolveProjectName(project.name, { [project.id]: project.name, [project.slug]: project.name, [project.name]: project.name }, aliasMap);
    if (!displaySeen.has(displayName)) {
      displaySeen.add(displayName);
      details.push({ rawName: matchedRaw, name: displayName, count });
    }
  }

  for (const [rawName, count] of usageMap) {
    if (count > 0) {
      const displayName = resolveProjectName(rawName, {}, aliasMap);
      if (!displaySeen.has(displayName)) {
        displaySeen.add(displayName);
        details.push({ rawName, name: displayName, count });
      }
    }
  }

  details.sort((a, b) => b.count - a.count);
  const totalCount = details.reduce((sum, d) => sum + d.count, 0);
  if (totalCount > 0 && details.length === 0) debugErrors.push("检测到 Pages 用量，但无法获取项目列表");

  return { count: totalCount, details, debugInfo: debugErrors.join(" | ") };
}

async function fetchPagesList(accountId, apiToken) {
  const headers = { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  let page = 1;
  const all = [];
  while (true) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?per_page=50&page=${page}`, { headers });
      if (!res.ok) break;
      const data = await res.json();
      all.push(...(data.result || []));
      const info = data.result_info;
      if (info && info.page < info.total_pages) page++;
      else break;
    } catch (e) { break; }
  }
  return all.map(p => ({
    id: String(p.id || p.project_id || p.uid || p.name || p.slug || ''),
    name: String(p.name || p.project_name || p.slug || p.id || ''),
    slug: String(p.slug || p.name || p.id || '')
  })).filter(x => x.id && x.name);
}

// ==================== 主汇总函数 ====================
async function fetchWorkerUsageCount(userId, apiKey, aliasMap = {}) {
  const defaultReturn = { workerCount: null, pagesCount: null, totalCount: null, workersDetails: [], pagesDetails: [], debugInfo: "" };
  if (!userId || !apiKey) return defaultReturn;
  const workerResult = await fetchWorkerProjectsUsage(userId, apiKey, aliasMap);
  const pagesResult = await fetchPagesProjectsUsage(userId, apiKey, aliasMap);
  const debugInfo = [workerResult.debugInfo, pagesResult.debugInfo].filter(Boolean).join(" | ");
  return {
    workerCount: workerResult.count, pagesCount: pagesResult.count, totalCount: workerResult.count + pagesResult.count,
    workersDetails: workerResult.details, pagesDetails: pagesResult.details, debugInfo: debugInfo
  };
}

// --- 前端脚本 (包含弹窗逻辑) ---
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

  // 弹窗控制
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.project-item');
    if (item) {
      document.getElementById('modalName').textContent = item.dataset.name;
      document.getElementById('modalRawName').textContent = item.dataset.raw;
      document.getElementById('modalCount').textContent = Number(item.dataset.count).toLocaleString() + ' 次';
      
      const modal = document.getElementById('detailsModal');
      const modalContent = modal.querySelector('.modal-content-scale');
      modal.classList.remove('hidden');
      setTimeout(() => {
        modal.classList.remove('opacity-0');
        modalContent.classList.remove('scale-95');
        modalContent.classList.add('scale-100');
      }, 10);
    }
  });

  function closeModal() {
    const modal = document.getElementById('detailsModal');
    const modalContent = modal.querySelector('.modal-content-scale');
    modal.classList.add('opacity-0');
    modalContent.classList.remove('scale-100');
    modalContent.classList.add('scale-95');
    setTimeout(() => { modal.classList.add('hidden'); }, 300);
  }
</script>
`;

// --- 生成展示卡片 UI ---
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

  const renderItem = (item, colorClass, bgClass) => `
    <div class="flex justify-between items-center bg-gray-50 hover:bg-gray-100 px-3 py-2 rounded-lg transition-all cursor-pointer project-item active:scale-[0.98]" 
         data-name="${item.name.replace(/"/g, '&quot;')}" data-raw="${item.rawName.replace(/"/g, '&quot;')}" data-count="${item.count}">
      <div class="flex items-center space-x-2 min-w-0 flex-1">
        <span class="w-2 h-2 rounded-full ${bgClass} flex-shrink-0"></span>
        <span class="text-xs text-gray-700 truncate">${item.name}</span>
      </div>
      <span class="text-xs font-semibold ${item.count === 0 ? 'text-gray-400' : colorClass} font-mono ml-2 flex-shrink-0">${item.count.toLocaleString()}</span>
    </div>
  `;

  const workersHtml = workersDetails.length ? workersDetails.map(w => renderItem(w, 'text-emerald-700', 'bg-emerald-500')).join('') 
    : `<div class="text-xs text-gray-400 text-center py-6">${workerCount > 0 ? '有用量但项目列表获取失败' : '暂无 Workers 项目'}</div>`;
  const pagesHtml = pagesDetails.length ? pagesDetails.map(p => renderItem(p, 'text-blue-700', 'bg-blue-500')).join('') 
    : `<div class="text-xs text-gray-400 text-center py-6">${pagesCount > 0 ? '有用量但项目列表获取失败' : '暂无 Pages 项目'}</div>`;

  const detailsHtml = `
    <div class="mt-2 pt-4 border-t border-gray-100">
      <div class="grid grid-cols-2 gap-4">
        <!-- 左：全部 Workers -->
        <div class="rounded-xl border border-emerald-100 bg-emerald-50/40 overflow-hidden flex flex-col">
          <div class="px-3 py-2.5 bg-emerald-50 border-b border-emerald-100 flex justify-between items-center">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              <span class="text-xs font-bold text-emerald-700">Workers</span>
            </div>
          </div>
          <div class="p-2 space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar">${workersHtml}</div>
        </div>
        <!-- 右：全部 Pages -->
        <div class="rounded-xl border border-blue-100 bg-blue-50/40 overflow-hidden flex flex-col">
          <div class="px-3 py-2.5 bg-blue-50 border-b border-blue-100 flex justify-between items-center">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
              <span class="text-xs font-bold text-blue-700">Pages</span>
            </div>
          </div>
          <div class="p-2 space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar">${pagesHtml}</div>
        </div>
      </div>
      ${debugInfo ? `<div class="mt-3 text-center"><span class="text-[10px] text-orange-600 bg-orange-50 px-2 py-1 rounded border border-orange-100">${debugInfo}</span></div>` : ''}
    </div>
  `;

  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col">
      <div class="px-5 py-4 cursor-pointer flex justify-between items-center bg-gray-50 hover:bg-gray-100 transition" onclick="toggleModule(this)">
        <h2 class="text-md font-bold text-gray-800 truncate select-none">${safeTag} 概览</h2>
        <svg class="w-5 h-5 text-gray-400 transform transition-transform duration-300" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </div>
      <div class="px-5 py-4">
        <div class="w-full bg-gray-100 rounded-full h-7 relative overflow-hidden shadow-inner flex">
          <div class="h-full bg-emerald-500 transition-all duration-500" style="width: ${workerPercent}%;" title="Workers: ${workerCount}"></div>
          <div class="h-full bg-blue-500 transition-all duration-500" style="width: ${pagesPercent}%;" title="Pages: ${pagesCount}"></div>
          <div class="absolute inset-0 flex items-center justify-center text-xs font-bold tracking-wide ${totalPercent} > 50 ? 'text-white drop-shadow-md' : 'text-gray-700'}">${totalPercent}%</div>
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
        </div>
        ${detailsHtml}
      </div>
    </div>
  `;
}

// --- 页面大盘基础布局 ---
function buildPageLayout(title, contentHtml, isSubPage = false) {
  const backBtnHtml = isSubPage ? `<div class="mb-6"><a href="/NicholasLai" class="inline-flex items-center text-blue-600 font-medium hover:text-blue-800 transition">← 返回监控面板</a></div>` : '';
  const bottomActionHtml = !isSubPage ? `<div class="flex justify-center mt-12 w-full"><a href="/NicholasLai/setting" class="w-full md:w-64 bg-gray-800 text-white text-center font-bold py-4 rounded-full shadow-lg hover:bg-gray-700 transition transform hover:scale-105 active:scale-95 duration-200">⚙️ 账号与授权配置</a></div>` : '';

  const modalHtml = `
    <div id="detailsModal" class="fixed inset-0 z-50 hidden bg-gray-900 bg-opacity-40 backdrop-blur-sm flex items-center justify-center p-4 transition-opacity duration-300 opacity-0" onclick="if(event.target === this) closeModal()">
      <div class="modal-content-scale bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden transform scale-95 transition-transform duration-300">
        <div class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/80">
          <h3 class="text-lg font-bold text-gray-800 flex items-center gap-2">🔍 项目详情</h3>
          <button onclick="closeModal()" class="text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-full p-1 transition">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
        <div class="p-6 space-y-5">
          <div class="bg-blue-50/50 p-4 rounded-xl border border-blue-100/50">
            <span class="text-xs font-semibold text-blue-600 mb-1 block uppercase tracking-wider">显示名称</span>
            <div id="modalName" class="font-bold text-gray-800 text-lg break-all"></div>
          </div>
          <div>
            <span class="text-xs font-semibold text-gray-500 mb-1 block uppercase tracking-wider">原始 ID (Raw Name)</span>
            <div id="modalRawName" class="text-sm font-mono text-gray-600 bg-gray-50 p-3 rounded-lg border border-gray-200 break-all"></div>
          </div>
          <div>
            <span class="text-xs font-semibold text-gray-500 mb-1 block uppercase tracking-wider">今日请求总计</span>
            <div id="modalCount" class="text-2xl font-bold text-emerald-600 font-mono tracking-tight drop-shadow-sm"></div>
          </div>
        </div>
        <div class="bg-gray-50 px-6 py-4 border-t border-gray-100 flex justify-end">
          <button onclick="closeModal()" class="px-5 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition shadow-sm">关闭</button>
        </div>
      </div>
    </div>
  `;

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
    <body class="bg-gray-50 min-h-screen py-10 px-4">
      <div class="max-w-6xl mx-auto w-full relative">
        ${backBtnHtml}
        <div class="text-center mb-10 w-full flex flex-col items-center">
          <h1 class="text-3xl md:text-4xl font-extrabold text-gray-800 tracking-tight mb-4 break-words px-2">${title}</h1>
          <div class="text-sm md:text-base text-gray-600 font-medium bg-white border border-gray-200 inline-flex flex-wrap justify-center items-center px-6 py-2.5 rounded-full shadow-sm">
            <span class="mr-2">⏱️</span><span>每日额度重置倒计时：</span>
            <span class="countdown-timer text-blue-600 font-bold ml-1 tracking-wider">计算中...</span>
          </div>
        </div>
        ${contentHtml}
        ${bottomActionHtml}
      </div>
      ${modalHtml}
      ${frontEndScript}
    </body>
    </html>
  `;
}

// --- API 处理逻辑 ---
async function handleGlobalApi(env) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const visibleData = configData.filter(c => c.showOnHome !== false); // API 也只返回允许显示的节点
  const quota = 100000;
  
  const results = await Promise.all(visibleData.map(async (item) => {
    if (!item.tag) return null;
    const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
    return {
      tag: item.tag, count: usage.totalCount === null ? -1 : usage.totalCount,
      workerCount: usage.workerCount === null ? -1 : usage.workerCount, pagesCount: usage.pagesCount === null ? -1 : usage.pagesCount,
      workersDetails: usage.workersDetails || [], pagesDetails: usage.pagesDetails || [],
      quota: quota, percent: usage.totalCount === null ? 0 : Number(Math.min((usage.totalCount / quota) * 100, 100).toFixed(1)),
      status: usage.totalCount === null ? 'error' : 'ok'
    };
  }));
  return new Response(JSON.stringify({ code: 200, data: results.filter(r => r !== null) }), { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
}

async function handleSpecificApi(env, targetTag) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const item = configData.find(c => c.tag === targetTag);
  if (!item) return new Response(JSON.stringify({ code: 404, message: 'Tag not found' }), { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, status: 404 });
  const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
  const data = {
    tag: item.tag, count: usage.totalCount === null ? -1 : usage.totalCount,
    workerCount: usage.workerCount === null ? -1 : usage.workerCount, pagesCount: usage.pagesCount === null ? -1 : usage.pagesCount,
    workersDetails: usage.workersDetails || [], pagesDetails: usage.pagesDetails || [],
    quota: 100000, percent: usage.totalCount === null ? 0 : Number(Math.min((usage.totalCount / 100000) * 100, 100).toFixed(1)),
    status: usage.totalCount === null ? 'error' : 'ok'
  };
  return new Response(JSON.stringify({ code: 200, data: data }), { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
}

// --- 主页逻辑 ---
async function handleDisplayPage(env) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  // 过滤并按序渲染主页显示的节点
  const displayData = configData.filter(item => item.showOnHome !== false);
  
  if (displayData.length === 0) {
    const emptyHtml = `<div class="text-center py-20 text-gray-500">暂无需要展示的项目，请前往配置页添加。</div>`;
    return new Response(buildPageLayout("Cloudflare 用量概览", emptyHtml, false), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  const cardsHtmlPromise = displayData.map(async (item) => {
    const usage = await fetchWorkerUsageCount(item.userId, item.apiKey, item.aliases || {});
    return generateCardHtml(item.tag, usage, 100000);
  });
  
  const resolvedCards = await Promise.all(cardsHtmlPromise);
  const contentHtml = `<div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 w-full">${resolvedCards.join('')}</div>`;
  
  return new Response(buildPageLayout("Cloudflare 用量", contentHtml, false), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

async function handleSpecificDisplayPage(env, targetTag, hostname) {
  const configData = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  const item = configData.find(c => c.tag === targetTag);
  if (!item) return Response.redirect(getMainDomainUrl(hostname), 302);
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
    </head>
    <body class="flex items-center justify-center p-4 bg-gray-50 min-h-screen">
      <div class="w-full max-w-md">
        <div class="text-center mb-6">
           <div class="text-xs text-gray-600 bg-white border border-gray-200 inline-flex items-center px-5 py-2 rounded-full shadow-sm">
             每日额度重置倒计时：<span class="countdown-timer font-bold tracking-wider ml-1 text-blue-600">计算中...</span>
           </div>
        </div>
        ${cardHtml}
      </div>
      <!-- 注入简易弹窗，不使用全局的复杂版以便保持单页轻量 -->
      <div id="detailsModal" class="fixed inset-0 z-50 hidden bg-gray-900 bg-opacity-40 backdrop-blur-sm flex items-center justify-center p-4" onclick="if(event.target === this) closeModal()">
        <div class="modal-content-scale bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden transform transition-all duration-300">
           <div class="p-5 space-y-4">
             <div><span class="text-xs text-gray-500">显示名称</span><div id="modalName" class="font-medium text-gray-800 break-all text-lg"></div></div>
             <div><span class="text-xs text-gray-500">原始 ID</span><div id="modalRawName" class="text-sm font-mono text-gray-600 bg-gray-50 p-2 rounded break-all mt-1"></div></div>
             <div><span class="text-xs text-gray-500">今日请求量</span><div id="modalCount" class="text-xl font-bold text-blue-600 font-mono mt-1"></div></div>
           </div>
           <button onclick="closeModal()" class="w-full py-3 bg-gray-50 text-gray-600 border-t border-gray-100 font-medium hover:bg-gray-100 transition">关闭</button>
        </div>
      </div>
      ${frontEndScript}
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// --- 设置页逻辑（动态支持拖拽、新增、删除，新增多级折叠功能） ---
async function handleSettingPage(env) {
  let data = JSON.parse(await env.KV_DATA.get('WORKER_CONFIG') || '[]');
  if(data.length === 0) data.push({ id: generateId(), tag: '', userId: '', apiKey: '', showOnHome: true, aliases: {} });

  const usagePromises = data.map(item => {
    if (item.userId && item.apiKey) return fetchWorkerUsageCount(item.userId, item.apiKey, {});
    return Promise.resolve(null);
  });
  const usages = await Promise.all(usagePromises);

  const cardsHtml = data.map((item, i) => {
    const u = usages[i];
    const existingAliases = item.aliases || {};
    const rawNames = new Set(Object.keys(existingAliases));
    const countMap = {};

    if (u) {
      u.workersDetails.forEach(d => { rawNames.add(d.rawName); countMap[d.rawName] = d.count; });
      u.pagesDetails.forEach(d => { rawNames.add(d.rawName); countMap[d.rawName] = d.count; });
    }

    let aliasRowsHtml = Array.from(rawNames).map(rawName => {
      const currentAlias = existingAliases[rawName] || '';
      const reqCount = countMap[rawName];
      const reqBadge = reqCount !== undefined 
        ? `<span class="bg-blue-50 text-blue-600 text-[10px] px-1.5 py-0.5 rounded border border-blue-100 font-mono tracking-tight whitespace-nowrap">${reqCount.toLocaleString()} 次</span>` 
        : `<span class="bg-gray-50 text-gray-400 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 font-mono tracking-tight whitespace-nowrap">无流量</span>`;

      return `
        <div class="flex flex-col bg-white p-3 rounded-lg border border-gray-200 shadow-sm mb-3 group transition hover:border-blue-300">
          <div class="flex justify-between items-start mb-2 gap-2">
            <span class="text-xs font-mono text-gray-600 break-all leading-relaxed"><span class="text-gray-400 select-none">原始 ID:</span> <strong>${rawName}</strong></span>
            <div class="flex-shrink-0 mt-0.5">${reqBadge}</div>
          </div>
          <div class="flex items-center">
            <span class="text-gray-300 mr-2 select-none">↳</span>
            <input type="text" data-raw="${rawName.replace(/"/g, '&quot;')}" value="${currentAlias}" placeholder="自定义显示名称 (留空显示原始ID)" class="alias-input w-full px-2 py-1.5 rounded-md text-xs bg-gray-50 border border-gray-200 focus:bg-white focus:ring-1 focus:ring-blue-500 outline-none transition" />
          </div>
        </div>
      `;
    }).join('');

    if (aliasRowsHtml === '') aliasRowsHtml = `<div class="text-xs text-gray-400 text-center py-5 bg-white rounded-lg border border-dashed border-gray-200">配置账号并保存后，系统将自动扫描项目以供配置别名。</div>`;

    const isShow = item.showOnHome !== false;
    const tagDisplay = item.tag || '未命名节点';

    return `
      <div class="node-card bg-white rounded-xl shadow-sm border border-gray-200 mb-5 relative group overflow-hidden" data-id="${item.id || generateId()}">
        
        <!-- 卡片头部：点击展开/折叠整个账号 -->
        <div class="cursor-pointer bg-gray-50 hover:bg-gray-100 flex justify-between items-center p-4 border-b border-gray-100 transition node-header" onclick="toggleNode(this)">
          <div class="flex items-center space-x-3">
            <div class="cursor-move text-gray-400 hover:text-blue-500 transition drag-handle p-1" title="拖拽排序" onclick="event.stopPropagation()">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
            </div>
            <h3 class="text-md font-bold text-gray-800 flex items-center gap-2">
              <span class="node-title-display">👤 ${tagDisplay}</span>
              <svg class="w-4 h-4 text-gray-500 transform transition-transform duration-200 chevron-icon rotate-180" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
            </h3>
          </div>
          <div class="flex items-center space-x-4" onclick="event.stopPropagation()">
            <label class="flex items-center space-x-1.5 text-sm font-medium text-gray-600 cursor-pointer select-none">
              <input type="checkbox" class="show-on-home-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" ${isShow ? 'checked' : ''}>
              <span>主页展示</span>
            </label>
            <button type="button" class="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-1 rounded text-xs font-semibold transition delete-node-btn">删除</button>
          </div>
        </div>
        
        <!-- 账号详细配置区：默认隐藏 -->
        <div class="node-content hidden p-5">
          <div class="space-y-3 mb-5">
            <input type="text" name="tag" value="${item.tag}" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-sm" oninput="updateNodeTitle(this)" />
            <input type="text" name="userId" value="${item.userId}" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-sm font-mono" />
            <input type="password" name="apiKey" value="${item.apiKey}" placeholder="API 令牌 (需 Read 权限)" class="w-full px-4 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-sm font-mono" />
          </div>

          <!-- 别名配置区：点击可展开/折叠 -->
          <div class="bg-gray-50/80 rounded-lg border border-gray-100 overflow-hidden">
            <div class="px-4 py-3 cursor-pointer flex justify-between items-center bg-gray-100/50 hover:bg-gray-200/50 transition alias-header" onclick="toggleAlias(this)">
              <h4 class="text-xs font-bold text-gray-600 flex items-center gap-1">🏷️ 项目别名配置</h4>
              <svg class="w-4 h-4 text-gray-400 transform transition-transform duration-200 alias-chevron rotate-180" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
            </div>
            <div class="alias-content hidden p-3 max-h-64 overflow-y-auto custom-scrollbar">
              ${aliasRowsHtml}
            </div>
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
      <title>参数配置</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
      <style>
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f3f4f6; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
        .sortable-ghost { opacity: 0.4; }
      </style>
    </head>
    <body class="bg-gray-50 min-h-screen py-10 px-4">
      <div class="max-w-3xl mx-auto w-full relative">
        <div class="flex justify-between items-center mb-8 w-full bg-white p-5 rounded-2xl shadow-sm border border-gray-200">
          <h1 class="text-xl md:text-2xl font-extrabold text-gray-800 tracking-tight">授权与排序配置</h1>
          <a href="/NicholasLai" class="text-blue-600 font-medium hover:text-blue-800 transition flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
            返回概览
          </a>
        </div>
        
        <form id="settings-form">
          <div id="node-list" class="space-y-4">
            ${cardsHtml}
          </div>
          
          <button type="button" id="add-node-btn" class="mt-4 w-full py-4 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 font-bold hover:bg-gray-50 hover:border-blue-400 hover:text-blue-500 transition-colors flex justify-center items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
            添加新节点
          </button>
          
          <button type="submit" id="save-btn" class="w-full bg-blue-600 text-white font-bold py-4 rounded-xl shadow-lg hover:bg-blue-700 hover:shadow-xl transition-all mt-8 sticky bottom-6 z-10 text-lg flex justify-center items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
            保存并应用配置
          </button>
        </form>
      </div>

      <!-- 新增节点时的模板 -->
      <template id="node-template">
        <div class="node-card bg-white rounded-xl shadow-sm border border-gray-200 mb-5 relative group overflow-hidden" data-id="">
          <div class="cursor-pointer bg-gray-50 hover:bg-gray-100 flex justify-between items-center p-4 border-b border-gray-100 transition node-header" onclick="toggleNode(this)">
            <div class="flex items-center space-x-3">
              <div class="cursor-move text-gray-400 hover:text-blue-500 transition drag-handle p-1" title="拖拽排序" onclick="event.stopPropagation()">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
              </div>
              <h3 class="text-md font-bold text-gray-800 flex items-center gap-2">
                <span class="node-title-display">👤 新增节点</span>
                <svg class="w-4 h-4 text-gray-500 transform transition-transform duration-200 chevron-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
              </h3>
            </div>
            <div class="flex items-center space-x-4" onclick="event.stopPropagation()">
              <label class="flex items-center space-x-1.5 text-sm font-medium text-gray-600 cursor-pointer select-none">
                <input type="checkbox" class="show-on-home-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" checked>
                <span>主页展示</span>
              </label>
              <button type="button" class="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-1 rounded text-xs font-semibold transition delete-node-btn">删除</button>
            </div>
          </div>
          
          <!-- 新建的节点默认展开，方便立刻输入内容 -->
          <div class="node-content p-5">
            <div class="space-y-3 mb-5">
              <input type="text" name="tag" value="" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none transition text-sm" oninput="updateNodeTitle(this)" />
              <input type="text" name="userId" value="" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono" />
              <input type="password" name="apiKey" value="" placeholder="API 令牌 (需 Read 权限)" class="w-full px-4 py-2.5 rounded-lg bg-gray-50 border border-gray-200 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono" />
            </div>
            <div class="bg-gray-50/80 rounded-lg p-3 border border-gray-100 text-xs text-gray-400 text-center py-5">
              填写账号并保存后，系统将自动扫描项目以供配置别名。
            </div>
          </div>
        </div>
      </template>

      <script>
        // 初始化拖拽
        const nodeList = document.getElementById('node-list');
        new Sortable(nodeList, { handle: '.drag-handle', animation: 200, ghostClass: 'sortable-ghost' });

        // 删除事件委托
        nodeList.addEventListener('click', (e) => {
          if (e.target.closest('.delete-node-btn')) {
            const card = e.target.closest('.node-card');
            card.style.opacity = '0';
            setTimeout(() => card.remove(), 200);
          }
        });

        // 账号层级的展开折叠
        function toggleNode(headerElement) {
          const content = headerElement.nextElementSibling;
          const icon = headerElement.querySelector('.chevron-icon');
          if (content.classList.contains('hidden')) {
            content.classList.remove('hidden');
            icon.classList.remove('rotate-180');
          } else {
            content.classList.add('hidden');
            icon.classList.add('rotate-180');
          }
        }

        // 别名层级的展开折叠
        function toggleAlias(headerElement) {
          const content = headerElement.nextElementSibling;
          const icon = headerElement.querySelector('.alias-chevron');
          if (content.classList.contains('hidden')) {
            content.classList.remove('hidden');
            icon.classList.remove('rotate-180');
          } else {
            content.classList.add('hidden');
            icon.classList.add('rotate-180');
          }
        }

        // 实时更新头部标题
        function updateNodeTitle(inputElement) {
          const titleSpan = inputElement.closest('.node-card').querySelector('.node-title-display');
          if (titleSpan) {
            titleSpan.textContent = '👤 ' + (inputElement.value || '未命名节点');
          }
        }

        // 新增节点
        document.getElementById('add-node-btn').addEventListener('click', () => {
          const template = document.getElementById('node-template').content.cloneNode(true);
          const newCard = template.querySelector('.node-card');
          newCard.dataset.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
          nodeList.appendChild(newCard);
        });

        // 保存配置
        document.getElementById('settings-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('save-btn');
          btn.innerHTML = '<svg class="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> 保存中...';
          btn.disabled = true;

          const cards = document.querySelectorAll('.node-card');
          const configArray = [];
          
          cards.forEach(card => {
            const id = card.dataset.id;
            const tag = card.querySelector('[name="tag"]').value;
            const userId = card.querySelector('[name="userId"]').value;
            const apiKey = card.querySelector('[name="apiKey"]').value;
            const showOnHome = card.querySelector('.show-on-home-checkbox').checked;
            
            const aliases = {};
            card.querySelectorAll('.alias-input').forEach(input => {
              const rawName = input.dataset.raw;
              const val = input.value.trim();
              if (val) aliases[rawName] = val;
            });
            
            configArray.push({ id, tag, userId, apiKey, showOnHome, aliases });
          });

          try {
            const res = await fetch('/NicholasLai/setting', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(configArray)
            });
            if(res.ok) window.location.href = '/NicholasLai';
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
  // 修改为接受纯 JSON 格式数据
  const newData = await request.json();
  await env.KV_DATA.put('WORKER_CONFIG', JSON.stringify(newData));
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

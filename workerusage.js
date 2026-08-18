export default {
  async fetch(request, env, _ctx) {
    try {
      if (!env.KV_DATA) {
        throw new Error("KV_DATA 未绑定。请检查 Cloudflare Worker 环境变量配置。");
      }

      // --- 登录密码保护逻辑 ---
      if (env.ADMIN_PASSWORD) {
        const authHeader = request.headers.get('Authorization');
        const expectedAuth = 'Basic ' + btoa('admin:' + env.ADMIN_PASSWORD);
        if (authHeader !== expectedAuth) {
          return new Response('需要管理员权限，请输入正确的账号 (admin) 和密码', {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Basic realm="NicholasLai Dashboard"',
              'Content-Type': 'text/plain;charset=UTF-8'
            }
          });
        }
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
          const action = url.searchParams.get('action');
          // 处理 POST 动作
          if (request.method === 'POST') {
            if (action === 'backup') return await handleBackupConfig(env);
            if (action === 'restore') return await handleRestoreConfig(request, env);
            if (action === 'import') return await handleImportConfig(request, env);
            return await handleSaveSettings(request, env);
          }
          // 处理 GET 动作
          if (action === 'export') return await handleExportConfig(env);
          if (action === 'list_backups') return await handleListBackups(env);
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
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200 flex flex-col justify-center items-center text-center h-full">
        <h2 class="text-base font-bold text-gray-800 mb-4 w-full truncate">${safeTag}</h2>
        <div class="text-xs text-red-500 bg-red-50 px-3 py-1.5 rounded border border-red-100">未配置或 API 令牌错误</div>
      </div>
    `;
  }

  const { workerCount, pagesCount, totalCount, workersDetails = [], pagesDetails = [], debugInfo } = usageData;
  const totalPercent = Math.min((totalCount / quota) * 100, 100).toFixed(1);
  const workerPercent = totalCount === 0 ? 0 : ((workerCount / quota) * 100).toFixed(1);
  const pagesPercent = totalCount === 0 ? 0 : ((pagesCount / quota) * 100).toFixed(1);

  const renderItem = (item, colorClass, bgClass) => `
    <div class="flex justify-between items-center bg-gray-50 hover:bg-gray-100 px-3 py-2.5 rounded-md transition-colors cursor-pointer project-item active:scale-[0.99] border border-transparent hover:border-gray-200" 
         data-name="${item.name.replace(/"/g, '&quot;')}" data-raw="${item.rawName.replace(/"/g, '&quot;')}" data-count="${item.count}">
      <div class="flex items-center space-x-2 min-w-0 flex-1">
        <span class="w-2 h-2 rounded-full ${bgClass} flex-shrink-0"></span>
        <span class="text-xs text-gray-700 truncate font-medium">${item.name}</span>
      </div>
      <span class="text-xs font-semibold ${item.count === 0 ? 'text-gray-400' : colorClass} font-mono ml-2 flex-shrink-0">${item.count.toLocaleString()}</span>
    </div>
  `;

  const workersHtml = workersDetails.length ? workersDetails.map(w => renderItem(w, 'text-emerald-600', 'bg-emerald-500')).join('') 
    : `<div class="text-xs text-gray-400 text-center py-6">${workerCount > 0 ? '有用量但项目列表获取失败' : '暂无 Workers 项目'}</div>`;
  const pagesHtml = pagesDetails.length ? pagesDetails.map(p => renderItem(p, 'text-blue-600', 'bg-blue-500')).join('') 
    : `<div class="text-xs text-gray-400 text-center py-6">${pagesCount > 0 ? '有用量但项目列表获取失败' : '暂无 Pages 项目'}</div>`;

  const detailsHtml = `
    <div class="mt-2 pt-4 border-t border-gray-100">
      <div class="grid grid-cols-2 gap-3">
        <!-- 左：全部 Workers -->
        <div class="rounded-lg border border-gray-100 bg-white overflow-hidden flex flex-col shadow-sm">
          <div class="px-3 py-2 bg-gray-50 border-b border-gray-100 flex justify-between items-center">
            <div class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-sm bg-emerald-500"></span>
              <span class="text-xs font-bold text-gray-600">Workers</span>
            </div>
          </div>
          <div class="p-1.5 space-y-1 max-h-64 overflow-y-auto custom-scrollbar">${workersHtml}</div>
        </div>
        <!-- 右：全部 Pages -->
        <div class="rounded-lg border border-gray-100 bg-white overflow-hidden flex flex-col shadow-sm">
          <div class="px-3 py-2 bg-gray-50 border-b border-gray-100 flex justify-between items-center">
            <div class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-sm bg-blue-500"></span>
              <span class="text-xs font-bold text-gray-600">Pages</span>
            </div>
          </div>
          <div class="p-1.5 space-y-1 max-h-64 overflow-y-auto custom-scrollbar">${pagesHtml}</div>
        </div>
      </div>
      ${debugInfo ? `<div class="mt-3 text-center"><span class="text-[10px] text-orange-600 bg-orange-50 px-2 py-1 rounded border border-orange-100">${debugInfo}</span></div>` : ''}
    </div>
  `;

  return `
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow duration-300 flex flex-col">
      <div class="px-5 py-4 cursor-pointer flex justify-between items-center hover:bg-gray-50 transition" onclick="toggleModule(this)">
        <h2 class="text-sm font-bold text-gray-700 truncate select-none">${safeTag}</h2>
        <svg class="w-4 h-4 text-gray-400 transform transition-transform duration-300" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </div>
      <div class="px-5 py-3">
        <div class="w-full bg-gray-100 rounded-md h-5 relative overflow-hidden flex">
          <div class="h-full bg-emerald-500 transition-all duration-500" style="width: ${workerPercent}%;" title="Workers: ${workerCount}"></div>
          <div class="h-full bg-blue-500 transition-all duration-500" style="width: ${pagesPercent}%;" title="Pages: ${pagesCount}"></div>
          <div class="absolute inset-0 flex items-center justify-center text-[10px] font-bold tracking-wide ${totalPercent > 50 ? 'text-white drop-shadow-md' : 'text-gray-700'}">${totalPercent}%</div>
        </div>
      </div>
      <div class="module-content hidden px-5 pb-5 border-t border-gray-50 pt-4 bg-gray-50/30">
        <div class="grid grid-cols-2 gap-3 text-center mb-1">
          <div class="py-2 px-1 bg-white rounded-md border border-gray-100 shadow-sm">
            <div class="text-[10px] text-gray-500 mb-0.5 font-medium">Workers 汇总</div>
            <div class="text-sm font-bold text-emerald-600">${workerCount.toLocaleString()}</div>
          </div>
          <div class="py-2 px-1 bg-white rounded-md border border-gray-100 shadow-sm">
            <div class="text-[10px] text-gray-500 mb-0.5 font-medium">Pages 汇总</div>
            <div class="text-sm font-bold text-blue-600">${pagesCount.toLocaleString()}</div>
          </div>
        </div>
        ${detailsHtml}
      </div>
    </div>
  `;
}

// --- 页面大盘基础布局 ---
function buildPageLayout(title, contentHtml, isSubPage = false) {
  const backBtnHtml = isSubPage ? `<div class="mb-6"><a href="/NicholasLai" class="inline-flex items-center text-blue-600 font-medium hover:text-blue-800 transition text-sm">← 返回监控面板</a></div>` : '';
  const bottomActionHtml = !isSubPage ? `
    <div class="flex justify-center mt-10 w-full pt-6 border-t border-gray-200">
      <a href="/NicholasLai/setting" class="px-6 py-2.5 bg-white border border-gray-200 rounded-md text-gray-600 text-sm font-medium hover:bg-gray-50 flex items-center gap-2 shadow-sm transition">
        <span class="text-orange-500">⚙️</span> 账户与配置管理
      </a>
    </div>` : '';

  const modalHtml = `
    <div id="detailsModal" class="fixed inset-0 z-50 hidden bg-gray-900 bg-opacity-40 backdrop-blur-sm flex items-center justify-center p-4 transition-opacity duration-300 opacity-0" onclick="if(event.target === this) closeModal()">
      <div class="modal-content-scale bg-white rounded-lg shadow-2xl w-full max-w-md overflow-hidden transform scale-95 transition-transform duration-300">
        <div class="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
          <h3 class="text-base font-bold text-gray-700 flex items-center gap-2">🔍 项目详情</h3>
          <button onclick="closeModal()" class="text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded p-1 transition">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
        <div class="p-6 space-y-4">
          <div class="bg-gray-50 p-4 rounded-md border border-gray-100">
            <span class="text-xs font-semibold text-gray-500 mb-1 block uppercase tracking-wider">显示名称</span>
            <div id="modalName" class="font-bold text-gray-800 text-base break-all"></div>
          </div>
          <div>
            <span class="text-xs font-semibold text-gray-500 mb-1 block uppercase tracking-wider">原始 ID (Raw Name)</span>
            <div id="modalRawName" class="text-xs font-mono text-gray-600 bg-gray-50 p-2.5 rounded-md border border-gray-200 break-all"></div>
          </div>
          <div>
            <span class="text-xs font-semibold text-gray-500 mb-1 block uppercase tracking-wider">今日请求总计</span>
            <div id="modalCount" class="text-xl font-bold text-blue-600 font-mono tracking-tight"></div>
          </div>
        </div>
        <div class="bg-gray-50 px-5 py-3 border-t border-gray-100 flex justify-end">
          <button onclick="closeModal()" class="px-5 py-1.5 bg-white border border-gray-300 rounded text-sm font-medium text-gray-600 hover:bg-gray-50 transition shadow-sm">关闭</button>
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
      <title>${title}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", STHeiti, "Microsoft YaHei", Tahoma, Simsun, sans-serif;
          background-color: #f1f5f9;
        }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
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
  
  return new Response(buildPageLayout("Cloudflare 用量概览", contentHtml, false), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// --- 独立单节点展示页逻辑 ---
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
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", STHeiti, "Microsoft YaHei", Tahoma, Simsun, sans-serif;
          background-color: #f1f5f9;
        }
      </style>
    </head>
    <body class="flex items-start justify-center pt-10 px-4 min-h-screen">
      <div class="w-full max-w-md">
        <div class="text-center mb-6">
           <div class="text-xs text-gray-600 bg-white border border-gray-200 inline-flex items-center px-4 py-1.5 rounded shadow-sm">
             每日重置倒计时：<span class="countdown-timer font-bold tracking-wider ml-1 text-orange-500">计算中...</span>
           </div>
        </div>
        ${cardHtml}
      </div>
      <!-- 注入简易弹窗 -->
      <div id="detailsModal" class="fixed inset-0 z-50 hidden bg-gray-900 bg-opacity-40 backdrop-blur-sm flex items-center justify-center p-4" onclick="if(event.target === this) closeModal()">
        <div class="modal-content-scale bg-white rounded-lg shadow-xl w-full max-w-sm overflow-hidden transform transition-all duration-300">
           <div class="p-5 space-y-4">
             <div><span class="text-xs text-gray-500 uppercase tracking-wider">显示名称</span><div id="modalName" class="font-medium text-gray-800 break-all text-base mt-1"></div></div>
             <div><span class="text-xs text-gray-500 uppercase tracking-wider">原始 ID</span><div id="modalRawName" class="text-xs font-mono text-gray-600 bg-gray-50 p-2 rounded border border-gray-100 break-all mt-1"></div></div>
             <div><span class="text-xs text-gray-500 uppercase tracking-wider">今日请求量</span><div id="modalCount" class="text-lg font-bold text-blue-600 font-mono mt-1"></div></div>
           </div>
           <button onclick="closeModal()" class="w-full py-2.5 bg-gray-50 text-gray-600 border-t border-gray-100 font-medium hover:bg-gray-100 transition text-sm">关闭</button>
        </div>
      </div>
      ${frontEndScript}
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// --- 设置页逻辑（图片风格 UI + 上下箭头排序 + 密码可见功能） ---
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
      <div class="node-card bg-white rounded-lg border border-gray-100 mb-3 group relative" data-id="${item.id || generateId()}">
        
        <!-- 卡片头部：清爽单行风格 -->
        <div class="cursor-pointer flex justify-between items-center p-4 hover:bg-gray-50 transition node-header" onclick="toggleNode(this)">
          <div class="flex items-center space-x-2 w-1/2 overflow-hidden">
            <span class="node-title-display text-sm font-medium text-gray-700 truncate">${tagDisplay}</span>
            <span class="text-red-500 text-xs hidden-label flex-shrink-0 ${isShow ? 'hidden' : ''}">[隐藏]</span>
          </div>
          
          <!-- 右侧图标操作区 -->
          <div class="flex items-center space-x-3 text-gray-400" onclick="event.stopPropagation()">
            <button type="button" class="hover:text-gray-700 transition" onclick="moveUp(this)" title="向上移动">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>
            </button>
            <button type="button" class="hover:text-gray-700 transition" onclick="moveDown(this)" title="向下移动">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
            </button>
            <button type="button" class="hover:text-orange-500 transition" onclick="toggleNode(this.closest('.node-card').querySelector('.node-header'))" title="编辑">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
            </button>
            <button type="button" class="hover:text-red-500 text-red-400 transition" onclick="removeNode(this)" title="删除">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
            <svg class="w-4 h-4 transition-transform duration-200 chevron-icon cursor-pointer" onclick="toggleNode(this.closest('.node-card').querySelector('.node-header'))" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          </div>
        </div>
        
        <!-- 账号详细配置区：默认隐藏 -->
        <div class="node-content hidden p-5 bg-gray-50/50 border-t border-gray-100">
          <label class="flex items-center space-x-1.5 text-sm font-medium text-gray-600 mb-4 cursor-pointer select-none">
            <input type="checkbox" class="show-on-home-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" ${isShow ? 'checked' : ''} onchange="updateHiddenLabel(this)">
            <span>在主页展示该节点</span>
          </label>
          
          <div class="space-y-3 mb-5">
            <input type="text" name="tag" value="${item.tag}" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" oninput="updateNodeTitle(this)" />
            <input type="text" name="userId" value="${item.userId}" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
            
            <!-- 带眼睛切换的密码框 -->
            <div class="relative w-full">
              <input type="password" name="apiKey" value="${item.apiKey}" placeholder="API 令牌 (需 Read 权限)" class="w-full px-4 py-2.5 pr-10 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
              <button type="button" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-blue-500 transition focus:outline-none" onclick="togglePassword(this)" title="显示/隐藏">
                <svg class="w-5 h-5 eye-closed" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path></svg>
                <svg class="w-5 h-5 eye-open hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.543 7-1.274 4.057-5.064 7-9.543 7-4.477 0-8.268-2.943-9.543-7z"></path></svg>
              </button>
            </div>
          </div>

          <!-- 别名配置区：点击可展开/折叠 -->
          <div class="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
            <div class="px-4 py-3 cursor-pointer flex justify-between items-center bg-gray-50 hover:bg-gray-100 transition alias-header" onclick="toggleAlias(this)">
              <h4 class="text-xs font-bold text-gray-600 flex items-center gap-1">🏷️ 项目别名配置</h4>
              <svg class="w-4 h-4 text-gray-400 transform transition-transform duration-200 alias-chevron rotate-180" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
            </div>
            <div class="alias-content hidden p-3 max-h-64 overflow-y-auto custom-scrollbar bg-gray-50/50">
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
      <title>账户与配置管理</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        /* 使用更现代、清爽的无衬线中文字体替换默认字体 */
        body {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", STHeiti, "Microsoft YaHei", Tahoma, Simsun, sans-serif;
          background-color: #f1f5f9;
        }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        /* 避免动画导致文字模糊 */
        .node-card { transform: translateZ(0); }
      </style>
    </head>
    <body class="min-h-screen py-8 px-4 flex justify-center items-start">
      <div class="w-full max-w-4xl bg-white rounded-xl shadow-sm border border-gray-200 p-6 md:p-8">
        
        <!-- 头部标题 -->
        <h1 class="text-xl md:text-2xl font-bold text-gray-800 tracking-wide mb-8 flex justify-center items-center gap-3">
          <svg class="w-7 h-7 text-indigo-800" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path></svg>
          账户与配置管理
        </h1>
        
        <form id="settings-form">
          <!-- 新增：控制栏 (备份/恢复/导出/导入) -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <button type="button" onclick="executeBackup()" class="w-full bg-[#10b981] hover:bg-[#059669] text-white font-medium py-2 rounded-md shadow-sm transition flex justify-center items-center gap-1.5 text-sm">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
              备份配置
            </button>
            <button type="button" onclick="openRestoreModal()" class="w-full bg-[#f59e0b] hover:bg-[#d97706] text-white font-medium py-2 rounded-md shadow-sm transition flex justify-center items-center gap-1.5 text-sm">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
              恢复配置
            </button>
            <a href="/NicholasLai/setting?action=export" class="w-full bg-[#8b5cf6] hover:bg-[#7c3aed] text-white font-medium py-2 rounded-md shadow-sm transition flex justify-center items-center gap-1.5 text-sm">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
              导出全部
            </a>
            <button type="button" onclick="document.getElementById('import-file').click()" class="w-full bg-[#3b82f6] hover:bg-[#2563eb] text-white font-medium py-2 rounded-md shadow-sm transition flex justify-center items-center gap-1.5 text-sm">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
              导入配置
            </button>
            <!-- 隐藏的导入文件域 -->
            <input type="file" id="import-file" class="hidden" accept=".json" onchange="executeImport(event)">
          </div>

          <div id="node-list" class="space-y-3">
            ${cardsHtml}
          </div>
          
          <!-- 大号橘色添加按钮 -->
          <button type="button" id="add-node-btn" class="w-full bg-[#f97316] hover:bg-[#ea580c] text-white font-bold py-3.5 rounded-lg shadow-sm transition-colors mt-4 flex justify-center items-center gap-1">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
            添加新账户
          </button>
          
          <!-- 底部小号操作按钮 -->
          <div class="flex justify-center items-center gap-4 mt-8 pt-6 border-t border-gray-100">
            <button type="submit" id="save-btn" class="px-5 py-2 bg-white border border-gray-200 rounded-md text-gray-600 text-sm hover:bg-gray-50 flex items-center gap-2 shadow-sm transition focus:outline-none">
              <span class="text-gray-400">📄</span> 保存并应用
            </button>
            <a href="/NicholasLai" class="px-5 py-2 bg-white border border-gray-200 rounded-md text-gray-600 text-sm hover:bg-gray-50 flex items-center gap-2 shadow-sm transition">
              <span class="text-orange-500">🏠</span> 返回主页
            </a>
          </div>
        </form>
      </div>

      <!-- 新增节点时的模板 -->
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
            <div class="space-y-3 mb-5">
              <input type="text" name="tag" value="" placeholder="网页标签名称 (如 niclai.vip)" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm shadow-sm" oninput="updateNodeTitle(this)" />
              <input type="text" name="userId" value="" placeholder="Cloudflare 账号 ID" class="w-full px-4 py-2.5 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
              <div class="relative w-full">
                <input type="password" name="apiKey" value="" placeholder="API 令牌 (需 Read 权限)" class="w-full px-4 py-2.5 pr-10 rounded-lg bg-white border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none transition text-sm font-mono shadow-sm" />
                <button type="button" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-blue-500 transition focus:outline-none" onclick="togglePassword(this)">
                  <svg class="w-5 h-5 eye-closed" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path></svg>
                  <svg class="w-5 h-5 eye-open hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.543 7-1.274 4.057-5.064 7-9.543 7-4.477 0-8.268-2.943-9.543-7z"></path></svg>
                </button>
              </div>
            </div>
            <div class="bg-white rounded-lg p-3 border border-gray-100 shadow-sm text-xs text-gray-400 text-center py-5">
              填写账号并保存后，系统将自动扫描项目以供配置别名。
            </div>
          </div>
        </div>
      </template>
	<!-- 恢复配置弹窗 -->
      <div id="restoreModal" class="fixed inset-0 z-50 hidden bg-gray-900 bg-opacity-40 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-sm overflow-hidden">
           <div class="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
             <h3 class="text-base font-bold text-gray-700 flex items-center gap-2">⏪ 选择恢复时间点</h3>
             <button onclick="closeRestoreModal()" class="text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded p-1 transition">
               <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
             </button>
           </div>
           <div class="p-4">
             <select id="backup-select" class="w-full px-3 py-2 rounded-md border border-gray-300 focus:ring-blue-500 outline-none text-sm bg-white mb-4">
               <option value="">加载中...</option>
             </select>
             <button onclick="executeRestore()" class="w-full bg-[#f97316] hover:bg-[#ea580c] text-white font-medium py-2.5 rounded shadow-sm transition text-sm">确认恢复并覆盖当前配置</button>
           </div>
        </div>
      </div>
      <script>
	  // --- 备份/恢复/导入 交互逻辑 ---
        async function executeBackup() {
          if(!confirm('确定要在 KV 内备份当前的配置数据吗？')) return;
          try {
            const res = await fetch('/NicholasLai/setting?action=backup', { method: 'POST' });
            const data = await res.json();
            if(data.code === 200) alert('✅ ' + data.message + '\\n备份名称: ' + data.key);
            else alert('备份失败: ' + data.message);
          } catch(e) { alert('请求异常'); }
        }

        async function openRestoreModal() {
          document.getElementById('restoreModal').classList.remove('hidden');
          const select = document.getElementById('backup-select');
          select.innerHTML = '<option value="">获取备份列表中...</option>';
          try {
            const res = await fetch('/NicholasLai/setting?action=list_backups');
            const data = await res.json();
            if (data.code === 200 && data.data.length > 0) {
              select.innerHTML = data.data.map(k => {
                // 将 backup_20260818_181005 格式化显示
                const formatName = k.replace('backup_', '').replace(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6');
                return `<option value="${k}">时间: ${formatName}</option>`;
              }).join('');
            } else {
              select.innerHTML = '<option value="">暂无可用备份</option>';
            }
          } catch(e) {
            select.innerHTML = '<option value="">获取失败</option>';
          }
        }

        function closeRestoreModal() {
          document.getElementById('restoreModal').classList.add('hidden');
        }

        async function executeRestore() {
          const key = document.getElementById('backup-select').value;
          if(!key) return alert('请先选择一个备份文件');
          if(!confirm('⚠️ 警告：恢复操作将完全覆盖当前所有配置且无法撤销！确定继续吗？')) return;
          
          try {
            const res = await fetch('/NicholasLai/setting?action=restore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key })
            });
            const data = await res.json();
            if (data.code === 200) {
              alert('✅ 恢复成功！即将刷新页面');
              location.reload();
            } else alert('恢复失败: ' + data.message);
          } catch(e) { alert('请求异常'); }
        }

        function executeImport(event) {
          const file = event.target.files[0];
          if (!file) return;
          if(!confirm('⚠️ 警告：导入的数据将完全覆盖当前所有配置！确定继续吗？')) {
            event.target.value = ''; // 取消则清空选择
            return;
          }
          
          const reader = new FileReader();
          reader.onload = async (e) => {
            const content = e.target.result;
            try {
              const res = await fetch('/NicholasLai/setting?action=import', {
                method: 'POST',
                body: content
              });
              const data = await res.json();
              if (data.code === 200) {
                alert('✅ 导入成功！即将刷新页面');
                location.reload();
              } else alert('导入失败: ' + data.message);
            } catch(err) { alert('请求异常'); }
          };
          reader.readAsText(file);
          event.target.value = ''; // 执行完毕清空
        }
		
        // 上下箭头排序功能
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

        // 密码框开合眼切换
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

        // 删除节点
        function removeNode(btn) {
          const card = btn.closest('.node-card');
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 200);
        }

        // 账号层级的展开折叠
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
            titleSpan.textContent = inputElement.value || '未命名节点';
          }
        }

        // 动态更新隐藏标签
        function updateHiddenLabel(checkbox) {
          const label = checkbox.closest('.node-card').querySelector('.hidden-label');
          if (checkbox.checked) {
            label.classList.add('hidden');
          } else {
            label.classList.remove('hidden');
          }
        }

        // 新增节点
        document.getElementById('add-node-btn').addEventListener('click', () => {
          const template = document.getElementById('node-template').content.cloneNode(true);
          const newCard = template.querySelector('.node-card');
          newCard.dataset.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
          document.getElementById('node-list').appendChild(newCard);
        });

        // 保存配置
        document.getElementById('settings-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('save-btn');
          btn.innerHTML = '<span class="animate-spin mr-1">⌛</span> 保存中...';
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

// ==================== 数据管理与备份恢复 ====================
async function handleBackupConfig(env) {
  const data = await env.KV_DATA.get('WORKER_CONFIG');
  if (!data) return new Response(JSON.stringify({ code: 400, message: '没有可备份的数据' }));
  
  // 生成东八区时间，格式：backup_20260818_181005
  const tzOffset = 8 * 60 * 60 * 1000;
  const now = new Date(Date.now() + tzOffset);
  const timeStr = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/[-:]/g, '');
  const backupKey = `backup_${timeStr}`;
  
  await env.KV_DATA.put(backupKey, data);
  return new Response(JSON.stringify({ code: 200, message: '备份成功', key: backupKey }));
}

async function handleListBackups(env) {
  const list = await env.KV_DATA.list({ prefix: 'backup_' });
  // 按照时间倒序排列（最新备份在最上）
  const keys = list.keys.map(k => k.name).sort().reverse();
  return new Response(JSON.stringify({ code: 200, data: keys }));
}

async function handleRestoreConfig(request, env) {
  const { key } = await request.json();
  if (!key) return new Response(JSON.stringify({ code: 400, message: '缺少备份键名' }));
  
  const data = await env.KV_DATA.get(key);
  if (!data) return new Response(JSON.stringify({ code: 404, message: '备份不存在' }));
  
  await env.KV_DATA.put('WORKER_CONFIG', data);
  return new Response(JSON.stringify({ code: 200, message: '恢复成功' }));
}

async function handleExportConfig(env) {
  const data = await env.KV_DATA.get('WORKER_CONFIG') || '[]';
  return new Response(data, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="cloudflare_dashboard_export_${Date.now()}.json"`
    }
  });
}

async function handleImportConfig(request, env) {
  try {
    const data = await request.text();
    // 校验 JSON 格式
    JSON.parse(data);
    await env.KV_DATA.put('WORKER_CONFIG', data);
    return new Response(JSON.stringify({ code: 200, message: '导入成功' }));
  } catch(e) {
    return new Response(JSON.stringify({ code: 400, message: '导入的数据格式错误' }));
  }
}

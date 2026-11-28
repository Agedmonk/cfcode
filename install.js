const CURRENT_VERSION = "1.4.202611281612"; // 当前版本号，置于顶部方便随时修改

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const PASSWORD = ''; // 输入自定义密码

    // ==================== 登录鉴权拦截 ====================
    const expectedPassword = env.PASSWORD || PASSWORD; // 从 CF 环境变量读取密码或使用自定义密码
    if (expectedPassword) {
      const cookies = request.headers.get("Cookie") || "";
      const authHeader = request.headers.get("Authorization") || "";
      const queryPwd = url.searchParams.get("pwd");

      const isAuthed =
        cookies.includes(`cf_auth=${expectedPassword}`) ||
        authHeader === `Bearer ${expectedPassword}` ||
        queryPwd === expectedPassword;

      // 处理登录表单提交
      if (path === "/login" && request.method === "POST") {
        const formData = await request.formData().catch(() => new FormData());
        const pass = formData.get("password");
        if (pass === expectedPassword) {
          return new Response("登录成功", {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": `cf_auth=${expectedPassword}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`
            }
          });
        }
        return new Response(getLoginPage("密码错误，请重试"), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }

      // 处理退出登录
      if (path === "/logout") {
        return new Response("已退出", {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": `cf_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`
          }
        });
      }

      // 未授权情况拦截
      if (!isAuthed) {
        if (path.startsWith("/api/")) {
          return new Response(JSON.stringify({ success: false, error: "未授权，请提供正确的密码或登录" }), {
            status: 401, headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(getLoginPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
    }
    // ======================================================

    // API 路由
    if (path === "/api/deploy") {
      if (request.method === "POST") return handleUnifiedDeploy(request, env);
      if (request.method === "GET") return handleGetDeploy(url, env);
    }
    if (path === "/api/deploy-worker" && request.method === "POST") return handleDeployWorker(request, env);
    if (path === "/api/deploy-pages" && request.method === "POST") return handleDeployPages(request, env);
    if (path === "/api/config" && request.method === "POST") return handleSaveConfig(request, env);

    // === 部署记录 API ===
    if (path === "/api/records") {
      if (request.method === "GET") return handleGetRecords(env);
      if (request.method === "DELETE") return handleClearRecords(env);
    }

    // === 账户与三区配置 API ===
    if (path === "/api/accounts") {
      if (request.method === "GET") return handleGetAccounts(env);
      if (request.method === "POST") return handlePostAccount(request, env);
      if (request.method === "DELETE") return handleDeleteAccount(url, env);
    }
    if (path === "/api/accounts/reorder" && request.method === "POST") {
      try {
        const body = await request.json();
        await saveAccountsList(env, body.accounts);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
    }
    // 保存全局 Worker / Pages 项目模板列表
    if (path === "/api/projects" && request.method === "POST") {
      return handleSaveGlobalProjects(request, env);
    }

    // === 数据备份、恢复、导出、导入 API ===
    if (path === "/api/accounts/backup") {
      if (request.method === "GET") return handleListBackups(env);
      if (request.method === "POST") return handleCreateBackup(env);
    }
    if (path === "/api/accounts/restore" && request.method === "POST") return handleRestoreBackup(request, env);
    if (path === "/api/accounts/export" && request.method === "GET") return handleExportAll(env);
    if (path === "/api/accounts/import" && request.method === "POST") return handleImportAll(request, env);

    // 页面路由
    if (path === "/" || path === "/index.html") return new Response(getMainPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (path === "/dashboard") return new Response(getDashboardPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (path === "/accounts") return new Response(getAccountsPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (path === "/records") return new Response(getRecordsPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    return new Response(getMainPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },
};

// ==================== 常量 ====================
const DEFAULT_WORKER_CODE_URL = "https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js";
const DEFAULT_PAGES_ZIP_URL = "https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip";
const ACCOUNTS_KEY = "accounts";
const DEPLOY_RECORDS_KEY = "deploy_records";
const MAX_DEPLOY_RECORDS = 200;

// ==================== 工具函数 ====================
function formatBeijingTime(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600000);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function normalizePrefixSlash(prefix) {
  const s = String(prefix || "").trim();
  if (!s) return "";
  return s.endsWith("/") ? s : `${s}/`;
}

// 统一归一化多 KV 数组（兼容旧版单 KV 字段）
function normalizeKvConfigs(kvs = [], kvName = "", kvAction = "keep", kvBinding = "") {
  const list = [];
  if (Array.isArray(kvs)) {
    kvs.forEach(item => {
      if (!item || typeof item !== "object") return;
      const name = String(item.name || item.kvName || item.repo || "").trim();
      const binding = String(item.binding || item.kvBinding || item.var || "").trim();
      const action = item.action === "clear" ? "clear" : "keep";
      if (name || binding) {
        list.push({ binding, name, action });
      }
    });
  }
  if (list.length === 0 && (String(kvName || "").trim() || String(kvBinding || "").trim())) {
    list.push({
      binding: String(kvBinding || "").trim(),
      name: String(kvName || "").trim(),
      action: kvAction === "clear" ? "clear" : "keep"
    });
  }
  return list;
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 部署记录存储函数 ====================
async function getDeployRecords(env) {
  try {
    const raw = await env.KV.get(DEPLOY_RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendDeployRecord(env, record) {
  try {
    const records = await getDeployRecords(env);
    const kvItems = Array.isArray(record.kvItems) ? record.kvItems : [];
    const envItems = Array.isArray(record.envItems) ? record.envItems : [];

    const entry = {
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      time: record.time || formatBeijingTime(),
      status: record.status || "成功",
      server: record.server || "",
      method: record.method || "Worker",
      projectName: record.projectName || "",
      kvItems,
      envItems,
      kvVar: record.kvVar || kvItems.map(k => k.name).join(", "),
      kvRepo: record.kvRepo || kvItems.map(k => `${k.repo}${k.action ? ` (${k.action})` : ''}`).join(", "),
      envVars: record.envVars || envItems.map(e => e.name).join(", "),
      envValues: record.envValues || envItems.map(e => e.value ?? "").join(", "),
      subdomain: record.subdomain || "",
      customDomains: record.customDomains || "",
      cfDomain: record.cfDomain || "",
      sourceUrl: record.sourceUrl || "",
      triggerSource: record.triggerSource || "单次部署",
      duration: record.duration || "",
      logs: Array.isArray(record.logs) ? record.logs.slice(-120) : []
    };
    records.unshift(entry);
    if (records.length > MAX_DEPLOY_RECORDS) {
      records.length = MAX_DEPLOY_RECORDS;
    }
    await env.KV.put(DEPLOY_RECORDS_KEY, JSON.stringify(records));
  } catch (e) {
    console.error("保存部署记录失败:", e);
  }
}

async function handleGetRecords(env) {
  const records = await getDeployRecords(env);
  return new Response(JSON.stringify({ success: true, records }), { headers: { "Content-Type": "application/json" } });
}

async function handleClearRecords(env) {
  try {
    await env.KV.put(DEPLOY_RECORDS_KEY, JSON.stringify([]));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

// 获取账户所有 KV 命名空间映射表（id -> title）
async function fetchAllKvNamespacesMap(accountId, headers) {
  const map = new Map();
  let page = 1;
  while (page <= 10) {
    try {
      const res = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
        { headers },
        12000
      );
      if (!res.ok) break;
      const kvList = await res.json();
      if (!kvList.success) break;
      const list = kvList.result || [];
      list.forEach(item => {
        if (item && item.id) map.set(item.id, item.title || item.id);
      });
      const totalPages = kvList.result_info?.total_pages || 1;
      if (page >= totalPages || list.length < 100) break;
      page++;
    } catch {
      break;
    }
  }
  return map;
}

// 支持分页遍历（per_page=100）与忽略大小写的 KV 命名空间查找函数
async function findKvNamespaceByTitle(accountId, headers, targetTitle) {
  const normalizedTarget = targetTitle.trim().toLowerCase();
  let page = 1;
  while (page <= 10) {
    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
      { headers },
      15000
    );
    const kvList = await res.json();
    if (!kvList.success) throw new Error(`查询 KV 失败: ${JSON.stringify(kvList.errors)}`);
    const list = kvList.result || [];
    const found = list.find(i => (i.title || "").trim().toLowerCase() === normalizedTarget);
    if (found) return found;
    const totalPages = kvList.result_info?.total_pages || 1;
    if (page >= totalPages || list.length < 100) break;
    page++;
  }
  return null;
}

// 统一处理 KV 获取、保留或清空重建逻辑（含 10014 冲突兜底）
async function resolveKvNamespaceId(accountId, headers, targetKvName, kvAction, log) {
  let existing = await findKvNamespaceByTitle(accountId, headers, targetKvName);
  if (existing) {
    if (kvAction === 'keep') {
      log(`[提示] 找到已存在同名 KV [${existing.title}]，执行保留策略...`);
      return existing.id;
    } else {
      log(`[提示] 找到已存在同名 KV [${existing.title}]，执行清空策略 (先删后建)...`);
      const del = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${existing.id}`, { method: "DELETE", headers }, 15000)).json();
      if (!del.success) throw new Error(`删除旧 KV 失败: ${JSON.stringify(del.errors)}`);
      const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", headers, body: JSON.stringify({ title: targetKvName }) }, 15000)).json();
      if (!create.success) throw new Error(`创建 KV 失败: ${JSON.stringify(create.errors)}`);
      return create.result.id;
    }
  } else {
    log(`[提示] 未找到同名 KV [${targetKvName}]，新建...`);
    const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", headers, body: JSON.stringify({ title: targetKvName }) }, 15000)).json();
    if (!create.success) {
      if (create.errors && create.errors.some(e => e.code === 10014)) {
        log(`[提示] 检测到同名 KV 已存在，正在重新定位并复用...`);
        existing = await findKvNamespaceByTitle(accountId, headers, targetKvName);
        if (existing) return existing.id;
      }
      throw new Error(`创建 KV 失败: ${JSON.stringify(create.errors)}`);
    }
    return create.result.id;
  }
}

// 获取账户的 workers.dev 子域名（若存在）
async function getWorkersSubdomain(accountId, headers) {
  try {
    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers },
      10000
    );
    if (!res.ok) return "";
    const data = await res.json();
    if (data.success && data.result && data.result.subdomain) {
      return `${data.result.subdomain}.workers.dev`;
    }
  } catch {}
  return "";
}

// 查询 Worker 已绑定的全部自定义域名（Custom Domains）
async function fetchWorkerBoundCustomDomains(accountId, headers, workerName) {
  try {
    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
      { headers },
      12000
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (data.success && Array.isArray(data.result)) {
      return data.result
        .filter(d => d.service === workerName && d.hostname)
        .map(d => `https://${d.hostname}`);
    }
  } catch {}
  return [];
}

// 查询 Pages 已绑定的全部自定义域名
async function fetchPagesBoundCustomDomains(accountId, headers, projectName, fallbackDomains = []) {
  try {
    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/domains`,
      { headers },
      12000
    );
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.result)) {
        const list = data.result
          .map(d => (typeof d === "string" ? d : d.name))
          .filter(name => name && !name.endsWith(".pages.dev"))
          .map(name => (name.startsWith("http") ? name : `https://${name}`));
        if (list.length > 0) return list;
      }
    }
  } catch {}

  if (Array.isArray(fallbackDomains) && fallbackDomains.length > 0) {
    return fallbackDomains
      .filter(name => name && !name.endsWith(".pages.dev"))
      .map(name => (name.startsWith("http") ? name : `https://${name}`));
  }
  return [];
}

// 配置 Worker 的 workers.dev 域名状态
async function configureWorkerDevDomain(accountId, headers, workerName, enableCfDomain, log) {
  const payload = enableCfDomain
    ? { enabled: true, previews_enabled: false }
    : { enabled: false, previews_enabled: false };

  log(`[CF域名] 正在${enableCfDomain ? '开启' : '关闭'} Worker [${workerName}] 的 workers.dev (Production: ${enableCfDomain ? '开启' : '关闭'}, Preview: 关闭)...`);
  try {
    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      },
      15000
    );
    const data = await res.json();
    if (data.success) {
      const subHost = await getWorkersSubdomain(accountId, headers);
      const cfUrl = subHost ? `https://${workerName}.${subHost}` : `${workerName}.workers.dev`;
      if (enableCfDomain) {
        log(`[CF域名][已开启] workers.dev (Production: 开启, Preview: 关闭) -> ${cfUrl}`);
        return cfUrl;
      } else {
        log(`[CF域名][已关闭] workers.dev (Production: 关闭, Preview: 关闭)`);
        return "";
      }
    } else {
      log(`[警告] 设置 workers.dev 状态失败: ${JSON.stringify(data.errors)}`);
      return enableCfDomain ? `${workerName}.workers.dev` : "";
    }
  } catch (err) {
    log(`[警告] 设置 workers.dev 状态异常: ${err.message}`);
    return enableCfDomain ? `${workerName}.workers.dev` : "";
  }
}

// 绑定 Worker 自定义域名（Custom Domains）
async function bindWorkerCustomDomain(accountId, headers, workerName, hostname, log) {
  const cleanHost = hostname.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!cleanHost || !cleanHost.includes('.')) {
    log(`[警告] 自定义域名格式无效 (${hostname})，跳过绑定`);
    return "";
  }

  log(`[附加] 正在为 Worker [${workerName}] 绑定自定义域: ${cleanHost}...`);
  try {
    const parts = cleanHost.split('.');
    let zoneId = null;
    for (let i = 0; i <= parts.length - 2; i++) {
      const candidateZone = parts.slice(i).join('.');
      const zRes = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidateZone)}&account.id=${accountId}`,
        { headers },
        15000
      );
      const zData = await zRes.json();
      if (zData.success && Array.isArray(zData.result) && zData.result.length > 0) {
        zoneId = zData.result[0].id;
        break;
      }
    }

    if (!zoneId) {
      log(`[警告] 未在当前账户下找到域名 [${cleanHost}] 对应的 Zone，请确认域名已托管在 Cloudflare`);
      return "";
    }

    const domRes = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          environment: "production",
          hostname: cleanHost,
          service: workerName,
          zone_id: zoneId
        })
      },
      15000
    );
    const domData = await domRes.json();
    if (domData.success) {
      log(`[成功] 自定义域已绑定: https://${cleanHost}`);
      return `https://${cleanHost}`;
    } else {
      log(`[警告] 自定义域绑定失败: ${JSON.stringify(domData.errors)}`);
      return "";
    }
  } catch (err) {
    log(`[警告] 自定义域绑定异常: ${err.message}`);
    return "";
  }
}

// ==================== KV 账户与全局项目存储管理 ====================
async function getStoredData(env) {
  try {
    const raw = await env.KV.get(ACCOUNTS_KEY);
    if (!raw) return { accounts: [], workerProjects: [], pageProjects: [], defaultPrefix: "", prefixes: [] };
    const parsed = JSON.parse(raw);
    let accounts = (parsed.accounts || []).map(a => ({
      ...a,
      cfDomain: a.cfDomain === true
    }));
    let workerProjects = Array.isArray(parsed.workerProjects) ? parsed.workerProjects : [];
    let pageProjects = Array.isArray(parsed.pageProjects) ? parsed.pageProjects : [];

    // 兼容旧版数据结构
    const hasLegacy = accounts.some(a => (a.workers && a.workers.length > 0) || (a.pages && a.pages.length > 0));
    if (workerProjects.length === 0 && pageProjects.length === 0 && hasLegacy) {
      const wMap = new Map();
      const pMap = new Map();
      accounts.forEach(acc => {
        if (!Array.isArray(acc.attachedWorkers)) acc.attachedWorkers = [];
        if (!Array.isArray(acc.attachedPages)) acc.attachedPages = [];
        (acc.workers || []).forEach((w, idx) => {
          const key = `${w.name}|${w.kvBinding || ''}|${w.kvName || ''}|${w.codeUrl || ''}`;
          let id = wMap.get(key);
          if (!id) {
            id = `w_mig_${Date.now()}_${wMap.size}_${idx}`;
            wMap.set(key, id);
            workerProjects.push({
              id,
              name: w.name,
              kvs: normalizeKvConfigs(w.kvs, w.kvName, w.kvAction, w.kvBinding),
              kvBinding: w.kvBinding || '',
              kvName: w.kvName || '',
              kvAction: w.kvAction || 'keep',
              codeUrl: w.codeUrl || '',
              subdomain: w.subdomain || '',
              envs: w.envs || [],
              show: w.show !== false
            });
          }
          if (!acc.attachedWorkers.includes(id)) acc.attachedWorkers.push(id);
        });
        (acc.pages || []).forEach((p, idx) => {
          const key = `${p.name}|${p.kvBinding || ''}|${p.kvName || ''}|${p.codeUrl || ''}`;
          let id = pMap.get(key);
          if (!id) {
            id = `p_mig_${Date.now()}_${pMap.size}_${idx}`;
            pMap.set(key, id);
            pageProjects.push({
              id,
              name: p.name,
              kvs: normalizeKvConfigs(p.kvs, p.kvName, p.kvAction, p.kvBinding),
              kvBinding: p.kvBinding || '',
              kvName: p.kvName || '',
              kvAction: p.kvAction || 'keep',
              codeUrl: p.codeUrl || '',
              envs: p.envs || [],
              show: p.show !== false
            });
          }
          if (!acc.attachedPages.includes(id)) acc.attachedPages.push(id);
        });
      });
    }

    const defPref = normalizePrefixSlash(parsed.defaultPrefix || "");
    let prefixes = Array.isArray(parsed.prefixes) ? parsed.prefixes.map(normalizePrefixSlash).filter(Boolean) : [];
    if (defPref && !prefixes.includes(defPref)) {
      prefixes.unshift(defPref);
    }
    const activePrefix = defPref || (prefixes[0] || "");

    return {
      accounts,
      workerProjects,
      pageProjects,
      defaultPrefix: activePrefix,
      prefixes
    };
  } catch {
    return { accounts: [], workerProjects: [], pageProjects: [], defaultPrefix: "", prefixes: [] };
  }
}

async function getAccountsList(env) {
  const data = await getStoredData(env);
  return data.accounts;
}

// ==================== Worker 部署核心 ====================
async function deployWorkerCore(accountId, apiToken, kvName, workerName, codeUrl, kvAction = 'keep', envs = [], kvBinding = '', customDomain = '', cfDomain = false, kvs = []) {
  const logs = [];
  const log = (msg) => logs.push(msg);
  let resolvedCfDomain = "";
  let newlyBoundCustomDomain = "";
  const kvItemsMap = new Map();
  const envItemsMap = new Map();
  const kvConfigs = normalizeKvConfigs(kvs, kvName, kvAction, kvBinding);

  try {
    if (!codeUrl || codeUrl.trim() === "" || codeUrl.trim() === "default") codeUrl = DEFAULT_WORKER_CODE_URL;
    if (!accountId || !apiToken || !workerName) {
      return { success: false, error: "缺少必填参数", logs: ["ERR: 缺少必填参数"], status: 400, resolvedSourceUrl: codeUrl, cfDomain: "", customDomains: [], kvItems: [], envItems: [] };
    }

    const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
    log(`[1/4] 拉取代码: ${codeUrl}`);
    const res = await fetchWithTimeout(codeUrl, {}, 15000);
    if (!res.ok) throw new Error(`拉取代码失败: HTTP ${res.status}`);
    const workerCode = await res.text();
    log(`[成功] 代码大小: ${workerCode.length} 字节`);

    const isESM = workerCode.includes("export default");
    let bindings = [];
    let kvIdToTitleMap = new Map();

    log(`[2/4] 检查并处理原有配置(KV/ENV)...`);
    try {
      const get = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/bindings`,
        { headers },
        15000
      );
      if (get.ok) {
        const data = await get.json();
        if (data.success && Array.isArray(data.result)) {
          bindings = data.result;
          const kvCount = bindings.filter(b => b.type === 'kv_namespace').length;
          const envCount = bindings.filter(b => b.type === 'plain_text' || b.type === 'secret_text').length;
          const otherCount = bindings.length - kvCount - envCount;
          let details = [];
          if (kvCount > 0) details.push(`KV ${kvCount} 个`);
          if (envCount > 0) details.push(`ENV ${envCount} 个`);
          if (otherCount > 0) details.push(`其他 ${otherCount} 个`);
          log(`[成功] 获取到原有配置: 共 ${bindings.length} 项 ${details.length > 0 ? '(' + details.join(', ') + ')' : ''}`);

          if (kvCount > 0) {
            kvIdToTitleMap = await fetchAllKvNamespacesMap(accountId, headers);
          }

          bindings.forEach(b => {
            if (b.type === 'kv_namespace') {
              const title = kvIdToTitleMap.get(b.namespace_id) || b.namespace_id || "";
              kvItemsMap.set(b.name, {
                name: b.name,
                repo: title,
                action: '原有',
                isNew: false
              });
            } else if (b.type === 'plain_text') {
              envItemsMap.set(b.name, {
                name: b.name,
                value: b.text ?? "",
                isNew: false
              });
            } else if (b.type === 'secret_text') {
              envItemsMap.set(b.name, {
                name: b.name,
                value: "(Secret 加密值)",
                isNew: false
              });
            }
          });
        } else {
          log(`[提示] 原项目没有绑定配置`);
        }
      } else if (get.status === 404) {
        log(`[提示] 属于全新项目，无旧配置`);
      } else {
        log(`[警告] 获取旧配置 API 异常: HTTP ${get.status}`);
      }
    } catch (err) {
      log(`[警告] 解析旧配置出错: ${err.message}`);
    }

    const validKvConfigs = kvConfigs.filter(c => c.name);
    if (validKvConfigs.length > 0) {
      for (let i = 0; i < validKvConfigs.length; i++) {
        const cfg = validKvConfigs[i];
        const targetKvName = cfg.name;
        const cfgAction = cfg.action === 'clear' ? 'clear' : 'keep';
        let bindName = cfg.binding;
        if (!bindName) {
          const existingKvBindings = bindings.filter(b => b.type === 'kv_namespace');
          bindName = existingKvBindings[i]?.name || existingKvBindings[0]?.name || (i === 0 ? "KV" : `KV_${i + 1}`);
        }

        log(`[提示] 正在配置 KV [${i + 1}/${validKvConfigs.length}] 仓库 [${targetKvName}] (KV变量: ${bindName})...`);
        const kvId = await resolveKvNamespaceId(accountId, headers, targetKvName, cfgAction, log);

        const newKvBindingObj = { type: "kv_namespace", name: bindName, namespace_id: kvId };
        const existBindIdx = bindings.findIndex(b => b.name === bindName);
        if (existBindIdx >= 0) {
          bindings[existBindIdx] = newKvBindingObj;
        } else {
          bindings.push(newKvBindingObj);
        }

        kvItemsMap.set(bindName, {
          name: bindName,
          repo: targetKvName,
          action: cfgAction === 'clear' ? '清空' : '保留',
          isNew: true
        });
        log(`[成功] KV 绑定配置完成 (KV变量: ${bindName}, 仓库: ${targetKvName}, ID: ${kvId})`);
      }
    } else {
      log(`[提示] 未指定新 KV仓库，保留原有 KV 绑定关系`);
    }

    log(`[3/4] 处理附加环境变量 (ENV)...`);
    if (envs && envs.length > 0) {
      envs.forEach(env => {
        if (!env.name) return;
        const existingIdx = bindings.findIndex(b => b.name === env.name);
        if (existingIdx >= 0) {
          if (env.action === 'replace') {
            bindings[existingIdx] = { type: "plain_text", name: env.name, text: env.value };
            envItemsMap.set(env.name, { name: env.name, value: env.value ?? "", isNew: true });
            log(`  - [更新] 替换已有变量: ${env.name}`);
          } else {
            if (!envItemsMap.has(env.name)) {
              const oldB = bindings[existingIdx];
              envItemsMap.set(env.name, {
                name: env.name,
                value: oldB.type === 'secret_text' ? "(Secret 加密值)" : (oldB.text ?? ""),
                isNew: false
              });
            }
            log(`  - [跳过] 保留已有变量: ${env.name}`);
          }
        } else {
          bindings.push({ type: "plain_text", name: env.name, text: env.value });
          envItemsMap.set(env.name, { name: env.name, value: env.value ?? "", isNew: true });
          log(`  - [新增] 添加新变量: ${env.name}`);
        }
      });
    } else {
      log(`[提示] 无附加环境变量，跳过。`);
    }

    const metadata = { bindings };
    if (isESM) metadata.main_module = "_worker.js"; else metadata.body_part = "script";
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    const blob = new Blob([workerCode], { type: isESM ? "application/javascript+module" : "application/javascript" });
    if (isESM) form.append("_worker.js", blob, "_worker.js"); else form.append("script", blob);

    log(`[4/4] 提交部署 Worker [${workerName}]...`);
    const dep = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, { method: "PUT", headers: { "Authorization": `Bearer ${apiToken}` }, body: form }, 20000)).json();
    if (!dep.success) throw new Error(`部署失败: ${JSON.stringify(dep.errors)}`);
    log(`[成功] 部署完成`);

    resolvedCfDomain = await configureWorkerDevDomain(accountId, headers, workerName, !!cfDomain, log);

    if (customDomain && customDomain.trim()) {
      newlyBoundCustomDomain = await bindWorkerCustomDomain(accountId, headers, workerName, customDomain.trim(), log);
    }

    const boundCustomDomains = await fetchWorkerBoundCustomDomains(accountId, headers, workerName);
    if (newlyBoundCustomDomain && !boundCustomDomains.includes(newlyBoundCustomDomain)) {
      boundCustomDomains.push(newlyBoundCustomDomain);
    }

    if (boundCustomDomains.length > 0) {
      log(`[自定义域] 已绑定域名: ${boundCustomDomains.join(', ')}`);
    } else {
      log(`[自定义域] 暂无绑定的自定义域名`);
    }

    return {
      success: true,
      logs,
      status: 200,
      resolvedSourceUrl: codeUrl,
      cfDomain: resolvedCfDomain,
      customDomains: boundCustomDomains,
      kvItems: Array.from(kvItemsMap.values()),
      envItems: Array.from(envItemsMap.values())
    };
  } catch (err) {
    log(`[错误] ${err.message}`);
    return {
      success: false,
      error: err.message,
      logs,
      status: 500,
      resolvedSourceUrl: codeUrl,
      cfDomain: "",
      customDomains: [],
      kvItems: Array.from(kvItemsMap.values()),
      envItems: Array.from(envItemsMap.values())
    };
  }
}

// ==================== ZIP 解压 ====================
async function extractZip(buf) {
  const files = [];
  const view = new DataView(buf);
  const dec = new TextDecoder();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("无效 ZIP：找不到 EOCD");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP 中央目录解析错误");
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOff = view.getUint32(offset + 42, true);

    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) {
      throw new Error("暂不支持 ZIP64 格式");
    }

    const nameBytes = new Uint8Array(buf, offset + 46, nameLen);
    const name = dec.decode(nameBytes);
    if (name.endsWith("/")) {
      offset += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compData = new Uint8Array(buf, dataOff, compSize);

    let data;
    if (method === 0) {
      data = compData.slice();
    } else if (method === 8) {
      try {
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([compData]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (rawError) {
        try {
          const ds2 = new DecompressionStream("deflate");
          const stream2 = new Blob([compData]).stream().pipeThrough(ds2);
          data = new Uint8Array(await new Response(stream2).arrayBuffer());
        } catch (zlibError) {
          if (compData.length > 6) {
            const stripped = compData.slice(2, compData.length - 4);
            try {
              const ds3 = new DecompressionStream("deflate-raw");
              const stream3 = new Blob([stripped]).stream().pipeThrough(ds3);
              data = new Uint8Array(await new Response(stream3).arrayBuffer());
            } catch (stripError) {
              throw new Error(`解压失败: ${stripError.message}`);
            }
          } else {
            throw new Error(`解压失败: ${rawError.message}`);
          }
        }
      }
    } else {
      throw new Error(`不支持的压缩方式：${method}`);
    }

    files.push({ path: name.replace(/^\/+/, ""), data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function sha256Hex(uint8array) {
  const digest = await crypto.subtle.digest("SHA-256", uint8array);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ==================== Pages 配置读取与更新函数 ====================
async function syncAndApplyPagesConfig(accountId, apiToken, projectName, kvName, logs, log, kvAction = 'keep', envs = [], kvBinding = '', existingProjData = null, kvs = []) {
  const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
  const kvItemsMap = new Map();
  const envItemsMap = new Map();
  const kvConfigs = normalizeKvConfigs(kvs, kvName, kvAction, kvBinding).filter(c => c.name);

  try {
    let projData = existingProjData;
    if (!projData) {
      log(`  - 拉取当前 Pages 项目配置...`);
      const projRes = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, { headers }, 15000);
      if (!projRes.ok) throw new Error(`获取 Pages 项目信息失败`);
      projData = await projRes.json();
    }

    let productionConfig = projData.result?.deployment_configs?.production || {};
    let previewConfig = projData.result?.deployment_configs?.preview || {};

    let kvNamespacesProd = { ...(productionConfig.kv_namespaces || {}) };
    let kvNamespacesPrev = { ...(previewConfig.kv_namespaces || {}) };

    let envVarsProd = { ...(productionConfig.env_vars || {}) };
    let envVarsPrev = { ...(previewConfig.env_vars || {}) };

    const existingKvEntries = Object.entries(kvNamespacesProd);
    if (existingKvEntries.length > 0) {
      const kvIdMap = await fetchAllKvNamespacesMap(accountId, headers);
      existingKvEntries.forEach(([kVar, kObj]) => {
        const nsId = kObj?.namespace_id || "";
        const title = kvIdMap.get(nsId) || nsId;
        kvItemsMap.set(kVar, {
          name: kVar,
          repo: title,
          action: '原有',
          isNew: false
        });
      });
    }

    Object.entries(envVarsProd).forEach(([eKey, eObj]) => {
      const isSecret = eObj?.type === 'secret_text';
      envItemsMap.set(eKey, {
        name: eKey,
        value: isSecret ? "(Secret 加密值)" : (eObj?.value ?? ""),
        isNew: false
      });
    });

    const hasNewKv = kvConfigs.length > 0;
    const hasNewEnv = Array.isArray(envs) && envs.some(e => e && e.name);

    if (hasNewKv) {
      const existingKeys = Object.keys(kvNamespacesProd);
      for (let i = 0; i < kvConfigs.length; i++) {
        const cfg = kvConfigs[i];
        const cfgAction = cfg.action === 'clear' ? 'clear' : 'keep';
        let bindName = cfg.binding;
        if (!bindName) {
          bindName = existingKeys[i] || existingKeys[0] || (i === 0 ? "KV" : `KV_${i + 1}`);
        }

        const kvId = await resolveKvNamespaceId(accountId, headers, cfg.name, cfgAction, (msg) => log(`  - ${msg}`));

        kvNamespacesProd[bindName] = { namespace_id: kvId };
        kvNamespacesPrev[bindName] = { namespace_id: kvId };
        kvItemsMap.set(bindName, {
          name: bindName,
          repo: cfg.name,
          action: cfgAction === 'clear' ? '清空' : '保留',
          isNew: true
        });
        log(`  - KV [${i + 1}/${kvConfigs.length}] 绑定就绪 (KV变量: ${bindName}, 仓库: ${cfg.name}, ID: ${kvId})`);
      }
    }

    if (hasNewEnv) {
      envs.forEach(env => {
        if (!env.name) return;
        if (envVarsProd[env.name] && env.action === 'keep') {
          log(`  - [跳过] 保留原有变量: ${env.name}`);
        } else {
          envVarsProd[env.name] = { type: "plain_text", value: env.value };
          envVarsPrev[env.name] = { type: "plain_text", value: env.value };
          envItemsMap.set(env.name, {
            name: env.name,
            value: env.value ?? "",
            isNew: true
          });
          log(`  - [更新/新增] 环境变量: ${env.name}`);
        }
      });
    }

    if (hasNewKv || hasNewEnv) {
      const updatePayload = {
        deployment_configs: {
          production: {},
          preview: {}
        }
      };

      if (hasNewKv) {
        updatePayload.deployment_configs.production.kv_namespaces = kvNamespacesProd;
        updatePayload.deployment_configs.preview.kv_namespaces = kvNamespacesPrev;
      }

      if (hasNewEnv) {
        updatePayload.deployment_configs.production.env_vars = envVarsProd;
        updatePayload.deployment_configs.preview.env_vars = envVarsPrev;
      }

      const updateRes = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, {
        method: "PATCH", headers, body: JSON.stringify(updatePayload)
      }, 15000);

      if (!updateRes.ok) {
        const err = await updateRes.json();
        throw new Error(`更新项目配置失败: ${JSON.stringify(err.errors)}`);
      }
      log(`  - 配置更新成功！`);
    }

    return {
      kvItems: Array.from(kvItemsMap.values()),
      envItems: Array.from(envItemsMap.values())
    };
  } catch (err) {
    log(`  - [错误] 处理配置失败: ${err.message}`);
    throw err;
  }
}

// ==================== Pages 部署核心 ====================
async function deployPagesCore(accountId, apiToken, kvName, projectName, zipUrl, kvAction = 'keep', envs = [], kvBinding = '', kvs = []) {
  const logs = [];
  const log = (msg) => logs.push(msg);
  let actualDomain = `${projectName}.pages.dev`;
  let projectDomainsList = [];
  let trackedKvItems = [];
  let trackedEnvItems = [];
  const kvConfigs = normalizeKvConfigs(kvs, kvName, kvAction, kvBinding);

  try {
    if (!zipUrl || zipUrl.trim() === "" || zipUrl.trim() === "default") zipUrl = DEFAULT_PAGES_ZIP_URL;
    if (!accountId || !apiToken || !projectName) {
      return { success: false, error: "缺少参数", logs: ["ERR: 缺少参数"], status: 400, resolvedSourceUrl: zipUrl, cfDomain: "", customDomains: [], kvItems: [], envItems: [] };
    }

    const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
    log(`[1/6] 下载 ZIP: ${zipUrl}`);
    const zipRes = await fetchWithTimeout(zipUrl, {}, 30000);
    if (!zipRes.ok) throw new Error(`下载失败`);
    const zipBuf = await zipRes.arrayBuffer();

    log(`[2/6] 解压...`);
    const files = await extractZip(zipBuf);

    log(`[3/6] 检查项目...`);
    let targetBranch = "main";
    let existingProjData = null;
    const check = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, { headers }, 30000);

    if (check.status === 404) {
      const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, { method: "POST", headers, body: JSON.stringify({ name: projectName, production_branch: "main" }) }, 30000)).json();
      if (!create.success) throw new Error(`创建失败: ${JSON.stringify(create.errors)}`);
      if (create.result && create.result.subdomain) actualDomain = create.result.subdomain;
      existingProjData = create;
    } else if (check.ok) {
      const projInfo = await check.json();
      existingProjData = projInfo;
      if (projInfo.result) {
        if (projInfo.result.subdomain) actualDomain = projInfo.result.subdomain;
        if (projInfo.result.production_branch) targetBranch = projInfo.result.production_branch;
        if (Array.isArray(projInfo.result.domains)) projectDomainsList = projInfo.result.domains;
      }
    } else {
      const errText = await check.text();
      throw new Error(`检查项目状态异常 (${check.status}): ${errText}`);
    }

    const formattedDomain = actualDomain.includes(".pages.dev") ? actualDomain : `${actualDomain}.pages.dev`;

    if (kvConfigs.some(c => c.name) || (envs && envs.length > 0)) {
      log(`[4/6] 读取并更新项目配置(KV/ENV)...`);
    } else {
      log(`[4/6] 读取现有项目配置(KV/ENV)...`);
    }
    const configResult = await syncAndApplyPagesConfig(
      accountId, apiToken, projectName,
      kvName ? kvName.trim() : "",
      logs, log, kvAction, envs, kvBinding, existingProjData, kvConfigs
    );
    trackedKvItems = configResult.kvItems;
    trackedEnvItems = configResult.envItems;

    log(`[5/6] 构建 manifest...`);
    const manifest = {};
    let workerFile = null;

    for (const file of files) {
      if (file.path === "_worker.js") { workerFile = file; continue; }
      manifest["/" + file.path] = { hash: await sha256Hex(file.data), size: file.data.length };
    }

    log(`[6/6] 提交上传...`);
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("branch", targetBranch);

    for (const file of files) {
      if (file.path === "_worker.js") continue;
      form.append("/" + file.path, new Blob([file.data]), file.path.split("/").pop() || "file");
    }

    if (workerFile) form.append("_worker.js", new Blob([workerFile.data], { type: "application/javascript+module" }), "_worker.js");

    const deployRes = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`, { method: "POST", headers: { "Authorization": `Bearer ${apiToken}` }, body: form }, 60000);
    const deployData = await deployRes.json();
    if (!deployData.success) {
      throw new Error(`部署失败: ${JSON.stringify(deployData.errors || deployData)}`);
    }
    log(`[成功] 部署完毕 ID: ${deployData.result.id}`);
    log(`[CF域名] https://${formattedDomain}`);

    const boundCustomDomains = await fetchPagesBoundCustomDomains(accountId, headers, projectName, projectDomainsList);
    if (boundCustomDomains.length > 0) {
      log(`[自定义域] 已绑定域名: ${boundCustomDomains.join(', ')}`);
    } else {
      log(`[自定义域] 暂无绑定的自定义域名`);
    }

    return {
      success: true,
      logs,
      deploymentId: deployData.result.id,
      projectName,
      status: 200,
      resolvedSourceUrl: zipUrl,
      cfDomain: `https://${formattedDomain}`,
      customDomains: boundCustomDomains,
      kvItems: trackedKvItems,
      envItems: trackedEnvItems
    };

  } catch (err) {
    log(`[错误] ${err.message}`);
    return {
      success: false,
      error: err.message,
      logs,
      status: 500,
      resolvedSourceUrl: zipUrl,
      cfDomain: "",
      customDomains: [],
      kvItems: trackedKvItems,
      envItems: trackedEnvItems
    };
  }
}

// ==================== 缺省前缀辅助函数 ====================
async function getSystemPrefix(env) {
  const data = await getStoredData(env);
  return data.defaultPrefix || "";
}

function processSourceUrl(url, prefix) {
  if (!url || url.trim() === "" || url.trim() === "default") return url;
  if (url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://')) return url.trim();
  const normPrefix = normalizePrefixSlash(prefix);
  return normPrefix ? (normPrefix + url.trim().replace(/^\/+/, '')) : url.trim();
}

async function findAccountByIdOrIdentifier(env, accountId) {
  const data = await getStoredData(env);
  if (!accountId) return null;
  return data.accounts.find(a => a.accountId === accountId || a.identifier === accountId) || null;
}

// ==================== 统一部署分发 ====================
async function deployByType(type, id, token, kv, name, source, kvAction = 'keep', envs = [], kvBinding = '', customDomain = '', cfDomain = false, kvs = []) {
  const t = String(type || "").toLowerCase();
  const src = source || "default";
  if (!t || !id || !token || !name) return { success: false, error: "参数缺失", logs: ["ERR"], status: 400, resolvedSourceUrl: src, cfDomain: "", customDomains: [], kvItems: [], envItems: [] };
  if (t === "worker") return deployWorkerCore(id, token, kv || "", name, src, kvAction, envs, kvBinding, customDomain, !!cfDomain, kvs);
  if (t === "page" || t === "pages") return deployPagesCore(id, token, kv || "", name, src, kvAction, envs, kvBinding, kvs);
  return { success: false, error: "type 无效", logs: ["ERR"], status: 400, resolvedSourceUrl: src, cfDomain: "", customDomains: [], kvItems: [], envItems: [] };
}

async function handleUnifiedDeploy(request, env) {
  const startTime = Date.now();
  const ct = request.headers.get("Content-Type") || "";
  let p = {};
  if (ct.includes("application/json")) {
    const b = await request.json().catch(() => ({}));
    p = {
      type: b.type,
      id: b.id || b.accountid,
      token: b.token,
      kvBinding: b.kvBinding || b.kvbinding || b.kvVar || b.kvvar || '',
      kv: b.kv || b.kvname,
      kvAction: b.kvAction || b.kvaction || 'keep',
      kvs: Array.isArray(b.kvs) ? b.kvs : [],
      name: b.name || b.projectname,
      source: b.source || b.codeurl || b.zipurl || b.url,
      envs: b.envs || [],
      customDomain: b.customDomain || b.customdomain || b.domain || '',
      subdomain: b.subdomain || '',
      cfDomain: b.cfDomain,
      serverLabel: b.serverLabel || '',
      triggerSource: b.triggerSource || 'API调用'
    };
  } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    let parsedKvs = [];
    const rawKvs = fd.get("kvs");
    if (rawKvs) {
      try { parsedKvs = JSON.parse(rawKvs); } catch {}
    }
    p = {
      type: fd.get("type"),
      id: fd.get("id") || fd.get("accountid"),
      token: fd.get("token"),
      kvBinding: fd.get("kvBinding") || fd.get("kvbinding") || fd.get("kvVar") || fd.get("kvvar") || '',
      kv: fd.get("kv") || fd.get("kvname"),
      kvAction: fd.get("kvAction") || fd.get("kvaction") || 'keep',
      kvs: parsedKvs,
      name: fd.get("name") || fd.get("projectname"),
      source: fd.get("source") || fd.get("codeurl") || fd.get("zipurl") || fd.get("url"),
      envs: [],
      customDomain: fd.get("customDomain") || fd.get("customdomain") || fd.get("domain") || '',
      subdomain: fd.get("subdomain") || '',
      cfDomain: fd.get("cfDomain") === "true" || fd.get("cfDomain") === "1",
      serverLabel: fd.get("serverLabel") || '',
      triggerSource: fd.get("triggerSource") || 'API调用'
    };
  }
  const matchedAcc = await findAccountByIdOrIdentifier(env, p.id);
  const enableCf = typeof p.cfDomain === "boolean" ? p.cfDomain : (matchedAcc ? matchedAcc.cfDomain === true : false);
  const serverDisplay = p.serverLabel || (matchedAcc ? `${matchedAcc.identifier} (${p.id})` : (p.id || ""));

  const prefix = await getSystemPrefix(env);
  p.source = processSourceUrl(p.source, prefix);
  const result = await deployByType(p.type, p.id, p.token, p.kv, p.name, p.source, p.kvAction, p.envs, p.kvBinding, p.customDomain, enableCf, p.kvs);

  const isWorker = String(p.type || "").toLowerCase() === "worker";
  const boundDomainsStr = Array.isArray(result.customDomains) ? result.customDomains.join(", ") : "";
  await appendDeployRecord(env, {
    time: formatBeijingTime(),
    status: result.success ? "成功" : "失败",
    server: serverDisplay,
    method: isWorker ? "Worker" : "Pages",
    projectName: p.name || "",
    kvItems: result.kvItems || [],
    envItems: result.envItems || [],
    subdomain: p.subdomain || (p.customDomain ? p.customDomain.split(".")[0] : ""),
    customDomains: boundDomainsStr,
    cfDomain: result.cfDomain || "",
    sourceUrl: result.resolvedSourceUrl || p.source || "",
    triggerSource: p.triggerSource || "API调用",
    duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    logs: result.logs || []
  });

  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleGetDeploy(url, env) {
  const startTime = Date.now();
  const q = url.searchParams;
  const prefix = await getSystemPrefix(env);
  const accId = q.get("accountid") || q.get("id");
  const matchedAcc = await findAccountByIdOrIdentifier(env, accId);
  const cfParam = q.get("cfDomain");
  const enableCf = cfParam !== null ? (cfParam === "true" || cfParam === "1") : (matchedAcc ? matchedAcc.cfDomain === true : false);
  const serverDisplay = matchedAcc ? `${matchedAcc.identifier} (${accId})` : (accId || "");

  const source = processSourceUrl(q.get("codeurl") || q.get("source") || q.get("zipurl") || "default", prefix);
  const kvBinding = q.get("kvBinding") || q.get("kvbinding") || q.get("kvVar") || q.get("kvvar") || "";
  const kvName = q.get("kvname") || q.get("kv") || "";
  const kvAction = q.get("kvAction") || 'keep';
  let kvs = [];
  if (q.get("kvs")) {
    try { kvs = JSON.parse(q.get("kvs")); } catch {}
  }
  const projName = q.get("projectname") || q.get("name") || "";
  const customDomain = q.get("customDomain") || q.get("customdomain") || q.get("domain") || "";
  const type = q.get("type");

  const result = await deployByType(type, accId, q.get("token"), kvName, projName, source, kvAction, [], kvBinding, customDomain, enableCf, kvs);
  const boundDomainsStr = Array.isArray(result.customDomains) ? result.customDomains.join(", ") : "";

  await appendDeployRecord(env, {
    time: formatBeijingTime(),
    status: result.success ? "成功" : "失败",
    server: serverDisplay,
    method: String(type || "").toLowerCase() === "worker" ? "Worker" : "Pages",
    projectName: projName,
    kvItems: result.kvItems || [],
    envItems: result.envItems || [],
    subdomain: customDomain ? customDomain.split(".")[0] : "",
    customDomains: boundDomainsStr,
    cfDomain: result.cfDomain || "",
    sourceUrl: result.resolvedSourceUrl || source,
    triggerSource: "GET API",
    duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    logs: result.logs || []
  });

  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleDeployWorker(request, env) {
  const startTime = Date.now();
  const b = await request.json().catch(() => ({}));
  const matchedAcc = await findAccountByIdOrIdentifier(env, b.accountId);
  const enableCf = typeof b.cfDomain === "boolean" ? b.cfDomain : (matchedAcc ? matchedAcc.cfDomain === true : false);
  const serverDisplay = b.serverLabel || (matchedAcc ? `${matchedAcc.identifier} (${b.accountId})` : (b.accountId || ""));

  const prefix = await getSystemPrefix(env);
  const codeUrl = processSourceUrl(b.codeUrl, prefix);
  const r = await deployWorkerCore(
    b.accountId, b.apiToken, b.kvName, b.workerName, codeUrl,
    b.kvAction || 'keep', b.envs || [], b.kvBinding || '', b.customDomain || '', enableCf, b.kvs || []
  );

  const boundDomainsStr = Array.isArray(r.customDomains) ? r.customDomains.join(", ") : "";
  await appendDeployRecord(env, {
    time: formatBeijingTime(),
    status: r.success ? "成功" : "失败",
    server: serverDisplay,
    method: "Worker",
    projectName: b.workerName || "",
    kvItems: r.kvItems || [],
    envItems: r.envItems || [],
    subdomain: b.customDomain ? b.customDomain.split(".")[0] : "",
    customDomains: boundDomainsStr,
    cfDomain: r.cfDomain || "",
    sourceUrl: r.resolvedSourceUrl || codeUrl || DEFAULT_WORKER_CODE_URL,
    triggerSource: b.triggerSource || "单次部署",
    duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    logs: r.logs || []
  });

  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json" } });
}

async function handleDeployPages(request, env) {
  const startTime = Date.now();
  const b = await request.json().catch(() => ({}));
  const matchedAcc = await findAccountByIdOrIdentifier(env, b.accountId);
  const serverDisplay = b.serverLabel || (matchedAcc ? `${matchedAcc.identifier} (${b.accountId})` : (b.accountId || ""));

  const prefix = await getSystemPrefix(env);
  const zipUrl = processSourceUrl(b.zipUrl, prefix);
  const r = await deployPagesCore(
    b.accountId, b.apiToken, b.kvName, b.projectName, zipUrl,
    b.kvAction || 'keep', b.envs || [], b.kvBinding || '', b.kvs || []
  );

  const boundDomainsStr = Array.isArray(r.customDomains) ? r.customDomains.join(", ") : "";
  await appendDeployRecord(env, {
    time: formatBeijingTime(),
    status: r.success ? "成功" : "失败",
    server: serverDisplay,
    method: "Pages",
    projectName: b.projectName || "",
    kvItems: r.kvItems || [],
    envItems: r.envItems || [],
    subdomain: "",
    customDomains: boundDomainsStr,
    cfDomain: r.cfDomain || (b.projectName ? `https://${b.projectName}.pages.dev` : ""),
    sourceUrl: r.resolvedSourceUrl || zipUrl || DEFAULT_PAGES_ZIP_URL,
    triggerSource: b.triggerSource || "单次部署",
    duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    logs: r.logs || []
  });

  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json" } });
}

// ==================== 账户与项目模板管理 API ====================
async function saveAccountsList(env, accounts) {
  const data = await getStoredData(env);
  data.accounts = accounts;
  await env.KV.put(ACCOUNTS_KEY, JSON.stringify(data));
}

async function handleGetAccounts(env) {
  const data = await getStoredData(env);
  return new Response(JSON.stringify({ success: true, ...data }), { headers: { "Content-Type": "application/json" } });
}

async function handleSaveConfig(request, env) {
  try {
    const body = await request.json();
    const data = await getStoredData(env);
    const normalizedDefault = normalizePrefixSlash(body.defaultPrefix || "");
    let prefixes = Array.isArray(body.prefixes)
      ? body.prefixes.map(normalizePrefixSlash).filter(Boolean)
      : [...(data.prefixes || [])];

    if (normalizedDefault && !prefixes.includes(normalizedDefault)) {
      prefixes.unshift(normalizedDefault);
    }
    data.prefixes = prefixes;
    data.defaultPrefix = normalizedDefault || (prefixes[0] || "");
    await env.KV.put(ACCOUNTS_KEY, JSON.stringify(data));
    return new Response(JSON.stringify({
      success: true,
      defaultPrefix: data.defaultPrefix,
      prefixes: data.prefixes
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleSaveGlobalProjects(request, env) {
  try {
    const body = await request.json();
    const data = await getStoredData(env);
    if (Array.isArray(body.workerProjects)) data.workerProjects = body.workerProjects;
    if (Array.isArray(body.pageProjects)) data.pageProjects = body.pageProjects;
    await env.KV.put(ACCOUNTS_KEY, JSON.stringify(data));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handlePostAccount(request, env) {
  try {
    const body = await request.json();
    if (!body?.identifier) return new Response(JSON.stringify({ success: false, error: "标识必填" }), { status: 400 });
    body.cfDomain = body.cfDomain === true;
    const data = await getStoredData(env);
    const idx = data.accounts.findIndex(a => a.identifier === body.identifier);
    if (idx >= 0) data.accounts[idx] = body; else data.accounts.push(body);
    await env.KV.put(ACCOUNTS_KEY, JSON.stringify(data));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  }
}

async function handleDeleteAccount(url, env) {
  const identifier = url.searchParams.get("identifier");
  const data = await getStoredData(env);
  const idx = data.accounts.findIndex(a => a.identifier === identifier);
  if (idx >= 0) {
    data.accounts.splice(idx, 1);
    await env.KV.put(ACCOUNTS_KEY, JSON.stringify(data));
    return new Response(JSON.stringify({ success: true }));
  }
  return new Response(JSON.stringify({ success: false }), { status: 404 });
}

// ==================== 数据备份管理 API ====================
async function handleCreateBackup(env) {
  try {
    const raw = await env.KV.get(ACCOUNTS_KEY);
    if (!raw) return new Response(JSON.stringify({ success: false, error: "无数据可备份" }));
    const d = new Date(); d.setTime(d.getTime() + 8 * 3600000);
    const pad = n => n.toString().padStart(2, '0');
    const key = `backup_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    await env.KV.put(key, raw);
    return new Response(JSON.stringify({ success: true, key }), { headers: { "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 }); }
}

async function handleListBackups(env) {
  try {
    const listed = await env.KV.list({ prefix: "backup_" });
    return new Response(JSON.stringify({ success: true, backups: listed.keys.map(k => k.name) }), { headers: { "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 }); }
}

async function handleRestoreBackup(request, env) {
  try {
    const { key } = await request.json();
    const raw = await env.KV.get(key);
    if (raw) { await env.KV.put(ACCOUNTS_KEY, raw); return new Response(JSON.stringify({ success: true })); }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  } catch (e) { return new Response(JSON.stringify({ success: false }), { status: 500 }); }
}

async function handleExportAll(env) {
  try {
    const allData = {};
    for (const k of (await env.KV.list()).keys) {
      const val = await env.KV.get(k.name);
      if (val) allData[k.name] = val;
    }
    return new Response(JSON.stringify(allData, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="cloudflare_kv_export.json"' }
    });
  } catch (e) { return new Response(JSON.stringify({ success: false }), { status: 500 }); }
}

async function handleImportAll(request, env) {
  try {
    const data = await request.json();
    for (const [k, v] of Object.entries(data)) await env.KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ success: false }), { status: 500 }); }
}

// ==================== 前端共享样式 ====================
const GLOBAL_STYLE = `
  :root {
    --primary: #f38020; --primary-hover: #e06c11;
    --bg: #f0f2f5; --card-bg: #ffffff;
    --text: #2c3e50; --text-light: #7f8c8d;
    --border: #eaedf1; --shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    --radius: 12px; --btn-radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 15px;
    -webkit-font-smoothing: antialiased;
  }
  .container { width: 100%; max-width: 980px; }
  .card { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); padding: 25px; }
  h2 { font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #1e293b; text-align: center; }

  input:not([type="checkbox"]):not([type="file"]), select {
    width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px;
    outline: none; transition: border-color 0.2s, box-shadow 0.2s; background: #fafbfc;
  }
  input:not([type="checkbox"]):not([type="file"]):focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(243, 128, 32, 0.1); background: #fff; }
  select:disabled { background: #f1f2f6; color: #a4b0be; cursor: not-allowed; }

  input[type="checkbox"] { width: auto; accent-color: var(--primary); cursor: pointer; transform: scale(1.1); margin-right: 6px; padding: 0; }

  button {
    border: none; border-radius: var(--btn-radius); cursor: pointer; font-size: 14px; font-weight: 500;
    transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
  .btn-danger { background: #e74c3c; color: #fff; }
  .btn-danger:hover { background: #c0392b; transform: translateY(-1px); }
  .btn-icon {
    background: transparent; color: var(--text-light); padding: 6px; border-radius: 6px;
  }
  .btn-icon:hover:not(:disabled) { background: #f1f2f6; color: var(--primary); }
  .btn-icon:disabled { opacity: 0.3; cursor: not-allowed; }
  .nav-links { text-align: center; margin-top: 20px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .nav-links a { display: inline-block; padding: 10px 20px; background: #fff; color: var(--text); border: 1px solid var(--border); border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 13px; transition: 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
  .nav-links a:hover { border-color: var(--primary); color: var(--primary); }
  .nav-links a.danger-link { color: #e74c3c; } .nav-links a.danger-link:hover { border-color: #e74c3c; background: #fff5f5; }
  textarea { width: 100%; height: 350px; background: #1e293b; color: #4ade80; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; padding: 15px; border-radius: 8px; border: none; resize: vertical; outline: none; line-height: 1.5; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }

  .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.5); justify-content: center; align-items: center; z-index: 1000; padding: 15px; backdrop-filter: blur(2px); }
  .modal.active { display: flex; }
  .modal-content { background: #fff; padding: 20px; border-radius: 12px; width: 100%; max-width: 750px; max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }

  .pwd-wrap { position: relative; display: flex; align-items: center; }
  .pwd-wrap input { padding-right: 36px !important; }
  .pwd-toggle { position: absolute; right: 10px; cursor: pointer; color: var(--text-light); display: flex; align-items: center; justify-content: center; transition: 0.2s; }
  .pwd-toggle:hover { color: var(--primary); }
`;

const ICONS = {
  up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  del: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
};

// ==================== 前端共享逻辑 ====================
const GLOBAL_SCRIPT = `
  function togglePwd(icon) {
    const input = icon.previousElementSibling;
    const eyeOpen = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const eyeClosed = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
    if (input.type === 'password') {
      input.type = 'text';
      icon.innerHTML = eyeOpen;
    } else {
      input.type = 'password';
      icon.innerHTML = eyeClosed;
    }
  }
`;

// ==================== 登录页面 ====================
function getLoginPage(errorMsg = "") {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>系统安全认证</title><style>${GLOBAL_STYLE}
    body { background: #f0f2f5; }
    .login-card { max-width: 360px; text-align: center; margin: auto; }
    .form-group { margin-bottom: 20px; text-align: left; }
    button { width: 100%; padding: 12px; font-size: 15px; }
    .error { color: #e74c3c; font-size: 13px; margin-bottom: 15px; background: #fff5f5; padding: 10px; border-radius: 6px; border: 1px solid #fed7d7; }
  </style></head><body>
  <div class="card login-card">
    <h2><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" style="vertical-align:bottom; margin-right:5px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> 部署工具验证</h2>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
    <form method="POST" action="/login">
      <div class="form-group">
        <div class="pwd-wrap">
          <input type="password" name="password" placeholder="请输入系统访问密码" required autofocus>
          <div class="pwd-toggle" onclick="togglePwd(this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></div>
        </div>
      </div>
      <button class="btn-primary" type="submit">登 录</button>
    </form>
  </div>
  <script>${GLOBAL_SCRIPT}</script>
</body></html>`;
}

// ==================== 主页面 ====================
function getMainPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>Cloudflare 部署工具</title><style>${GLOBAL_STYLE}
    .form-group { margin-bottom: 15px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text-light); }
    .accordion { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 10px; background: #fff; }
    .accordion-header { background: #fafbfc; padding: 14px 16px; cursor: pointer; font-weight: 500; font-size: 14px; display: flex; justify-content: space-between; align-items: center; user-select: none; transition: 0.2s; }
    .accordion-header:hover { background: #f1f2f6; }
    .accordion-content { display: none; padding: 16px; border-top: 1px solid var(--border); }
    .accordion-content.active { display: block; }
    button.action-btn { width: 100%; padding: 12px; margin-top: 10px; }

    .cf-monitor-bar { display: none; margin-bottom: 8px; padding: 8px 12px; border-radius: 6px; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; font-size: 12px; line-height: 1.6; word-break: break-all; }
    .cf-monitor-bar.active { display: block; }

    pre { background: #f8fafc; color: #334155; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin-bottom: 10px; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; }
    .info-section { margin-bottom: 20px; }
    .info-section h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; color: #1e293b; }
    .info-section p { font-size: 13px; color: #475569; margin-bottom: 8px; line-height: 1.6; }
  </style></head><body>
  <div class="container" style="max-width: 620px;">
    <div class="card">
      <h2>☁️ Cloudflare 部署工具</h2>
      <div class="form-group"><label>Account ID</label><input type="text" id="accountId" placeholder="例如：8ab2...c8d0"></div>
      <div class="form-group"><label>API Token</label>
        <div class="pwd-wrap">
          <input type="password" id="apiToken" placeholder="例如：cfcut_...">
          <div class="pwd-toggle" onclick="togglePwd(this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></div>
        </div>
      </div>
      <div class="form-group"><label>项目名称</label><input type="text" id="projectName" placeholder="Worker或Pages名称"></div>

      <!-- KV 设置区（参考 ENV 设置区，勾选才展开，支持多 KV 绑定） -->
      <div class="form-group" style="border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; margin-top: 10px; background:#fafbfc;">
        <label style="display:flex; align-items:center; cursor:pointer; color:#334155; margin-bottom:0;">
          <input type="checkbox" id="enableKv" style="margin-right:8px; width:auto;"> 附加 KV 绑定 (KV)
        </label>
        <div id="kvContainer" style="display:none; margin-top:10px;">
          <div id="kvList"></div>
          <button class="btn-primary" id="btnAddKv" style="background:#e2e8f0; color:#475569; padding:6px 12px; font-size:12px; margin-top:8px;">➕ 添加 KV</button>
        </div>
      </div>

      <!-- ENV 设置区 -->
      <div class="form-group" style="border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; margin-top: 10px; background:#fafbfc;">
        <label style="display:flex; align-items:center; cursor:pointer; color:#334155; margin-bottom:0;">
          <input type="checkbox" id="enableEnv" style="margin-right:8px; width:auto;"> 附加环境变量 (ENV)
        </label>
        <div id="envContainer" style="display:none; margin-top:10px;">
          <div id="envList"></div>
          <button class="btn-primary" id="btnAddEnv" style="background:#e2e8f0; color:#475569; padding:6px 12px; font-size:12px; margin-top:8px;">➕ 添加变量</button>
        </div>
      </div>

      <div class="accordion">
        <div class="accordion-header" data-target="workerPanel"><span>🚀 Worker 部署</span><span class="arrow">▼</span></div>
        <div id="workerPanel" class="accordion-content">
          <div class="form-group"><label>代码源地址</label><input type="url" id="workerCodeUrl" value="https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js"></div>
          <div class="form-group"><label>自定义域（可选，完整域名）</label><input type="text" id="workerCustomDomain" placeholder="例如：app.example.com（留空不绑定）"></div>
          <div class="form-group">
            <label style="display:flex; align-items:center; cursor:pointer; color:#334155; margin-bottom:0;">
              <input type="checkbox" id="workerEnableCfDomain"> CF域名（开启 workers.dev：Production 开启、Preview 关闭；取消则均关闭）
            </label>
          </div>
          <button id="btnDeployWorker" class="btn-primary action-btn">开始部署 Worker</button>
        </div>
      </div>
      <div class="accordion">
        <div class="accordion-header" data-target="pagesPanel"><span>📄 Pages 部署</span><span class="arrow">▼</span></div>
        <div id="pagesPanel" class="accordion-content">
          <div class="form-group"><label>ZIP 文件地址</label><input type="url" id="pagesZipUrl" value="https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip"></div>
          <button id="btnDeployPages" class="btn-primary action-btn">开始部署 Pages</button>
        </div>
      </div>

      <div style="margin-top: 20px;">
        <label style="font-size:13px; font-weight:500;">监视窗口 / 部署日志</label>
        <div id="cfDomainMonitor" class="cf-monitor-bar"></div>
        <textarea id="logOutput" readonly placeholder="日志输出..."></textarea>
      </div>

      <div class="accordion" style="margin-top: 15px;">
        <div class="accordion-header" data-target="infoPanel"><span>📖 使用说明</span><span class="arrow">▼</span></div>
        <div id="infoPanel" class="accordion-content">
          <div class="info-section">
            <h3>📋 三区配置、多 KV 绑定、CF域名开关与缺省前缀说明</h3>
            <p>点击底部 <strong>📋 常用部署</strong> -> <strong>⚙️ 账户设置</strong>，支持多服务器组、多 KV 绑定与全局项目复用：</p>
            <pre><code>1. 多 KV 绑定支持：
   - 主页与项目设置区均支持绑定多个 KV（多个变量各自对应不同的 KV 仓库与保留/清空策略）。
   - 主页的“附加 KV 绑定 (KV)”勾选后展开，点击“➕ 添加 KV”可添加多组；项目设置区的 KV 设置区同样支持动态添加多组 KV。

2. 第一区【服务器设置（账户组）】：
   - 配置组标识、Account ID、API Token、默认组环境变量(ENV)以及【组项目域名】（例如：example.com）。
   - 每个服务器组内均配有【CF域名】可选框：勾选后开启 CF 提供的 workers.dev 域名（Production 开启、Preview 关闭）；取消勾选则关闭 workers.dev 域名（Production 与 Preview 均关闭）。

3. 第二区【Worker 项目区】与第三区【Pages 项目区】：
   - 全局维护 Worker / Pages 项目模板，支持多组 KV 绑定、独立环境变量(ENV)及 Worker 自定义子域名。
   - 设为隐藏的项目会归类收纳至“隐藏的项目”折叠标签中，点击可展开管理。

4. 【缺省地址前缀】与【部署记录】：
   - 每次部署均会自动保存至【部署记录】（/records），同时记录项目原有的 KV/ENV（蓝色字体）与本次新设置/替换的 KV/ENV（绿色字体），并支持导出为 XLSX 或 JSON 文件。</code></pre>
          </div>
          <div class="info-section">
            <h3>🌐 单次页面部署</h3>
            <p>填写 Account ID、API Token 和项目名称，如需绑定 KV 可勾选“附加 KV 绑定 (KV)”展开配置，展开对应部署面板后点击部署。</p>
          </div>
          <div class="info-section">
            <h3>⚡ POST 部署</h3>
            <p>向 <code>/api/deploy</code> 发送 POST 请求，支持 JSON 或表单格式（可通过 <code>kvs: [{ binding, name, action }]</code> 传递多个 KV 绑定，或使用 <code>kvBinding</code>/<code>kv</code>/<code>kvAction</code> 传递单个 KV）。</p>
            <pre><code>fetch("https://your-worker.workers.dev/api/deploy", {
  method: "POST",
  headers: {
    "Authorization": "Bearer 您的系统访问密码",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    type: "worker",
    id: "YOUR_ACCOUNT_ID",
    token: "YOUR_API_TOKEN",
    kvs: [
      { binding: "KV_MAIN", name: "MY_KV_1", action: "keep" },
      { binding: "KV_CACHE", name: "MY_KV_2", action: "clear" }
    ],
    name: "my-worker-app",
    source: "default",
    cfDomain: true
  })
}).then(res => res.json()).then(console.log);</code></pre>
          </div>
        </div>
      </div>

      <div class="nav-links" style="align-items: center;">
        <a href="/dashboard">📋 常用部署</a>
        <a href="/records">📜 部署记录</a>
        <a href="javascript:void(0)" id="versionBtn" style="border-color: #10b981; color: #10b981; border-radius: 8px; padding: 8px 16px;">获取版本中...</a>
        <a href="/logout" class="danger-link">🚪 退出登录</a>
      </div>
    </div>
  </div>

  <div id="updateModal" class="modal">
    <div class="modal-content" style="max-width: 320px; text-align: center;">
      <h3 style="margin-bottom:15px; font-size:16px;">🔔 发现系统新版本</h3>
      <p id="updateModalText" style="font-size: 13px; color: #475569; margin-bottom: 20px; white-space: pre-wrap; line-height: 1.6;"></p>
      <div style="display:flex; gap:10px;">
        <button id="btnConfirmUpdate" class="btn-primary" style="background:#10b981; flex:1;">🔄 更新</button>
        <button id="btnCancelUpdate" class="btn-danger" style="background:#f1f5f9; color:#475569; flex:1;">忽略</button>
      </div>
    </div>
  </div>

  <script>
    ${GLOBAL_SCRIPT}
    (function () {
      let allAccountsForUpdate = [];
      let allWorkerProjectsForUpdate = [];
      fetch('/api/accounts').then(res => res.json()).then(data => {
        if (data.success) {
          allAccountsForUpdate = data.accounts || [];
          allWorkerProjectsForUpdate = data.workerProjects || [];
        }
      }).catch(err => console.error('账户列表加载失败', err));

      fetch('https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/version.json')
        .then(res => res.json())
        .then(data => {
          const vBtn = document.getElementById('versionBtn');
          if (vBtn && data.version) {
            const latestVersion = data.version;
            if (latestVersion !== '${CURRENT_VERSION}') {
              vBtn.textContent = '✨ 发现新版 v' + latestVersion;
              vBtn.style.backgroundColor = '#10b981';
              vBtn.style.color = '#fff';

              vBtn.addEventListener('click', () => {
                document.getElementById('updateModalText').innerText = '当前版本: v${CURRENT_VERSION}\\n最新版本: v' + latestVersion;
                document.getElementById('updateModal').classList.add('active');
              });
            } else {
              vBtn.textContent = 'v${CURRENT_VERSION} (已最新)';
              vBtn.style.color = '#7f8c8d';
              vBtn.style.borderColor = '#eaedf1';
              vBtn.style.cursor = 'default';
            }
          }
        }).catch(err => console.error('获取版本失败', err));

      document.getElementById('btnCancelUpdate')?.addEventListener('click', () => {
        document.getElementById('updateModal').classList.remove('active');
      });

      document.getElementById('btnConfirmUpdate')?.addEventListener('click', async () => {
        document.getElementById('updateModal').classList.remove('active');
        const output = document.getElementById('logOutput');
        output.value = '准备自动更新系统...\\n';

        const domain = window.location.hostname;
        const installProj = allWorkerProjectsForUpdate.find(w => w.name === 'install');

        let targetAcc = allAccountsForUpdate.find(a => domain.includes(a.identifier) || (a.identifier && a.identifier.includes(domain)) || (a.domain && domain.endsWith(a.domain)));
        if (!targetAcc && installProj) {
          targetAcc = allAccountsForUpdate.find(a => Array.isArray(a.attachedWorkers) && a.attachedWorkers.includes(installProj.id));
        }
        if (!targetAcc && allAccountsForUpdate.length > 0) targetAcc = allAccountsForUpdate[0];

        if (!targetAcc) {
          output.value += '[错误] 无法定位部署账户，请先在【常用部署】中配置相关 AccountID 及 Token。\\n';
          return;
        }

        output.value += '[信息] 匹配账户标识: ' + targetAcc.identifier + '\\n';
        output.value += '[信息] 目标更新项目: install\\n';
        output.scrollTop = output.scrollHeight;

        const payload = {
          accountId: targetAcc.accountId,
          apiToken: targetAcc.token,
          kvs: [],
          workerName: 'install',
          codeUrl: 'https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/install.js',
          cfDomain: targetAcc.cfDomain === true
        };

        try {
          const res = await fetch('/api/deploy-worker', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
          });
          const data = await res.json();
          output.value += (data.logs || []).join('\\n') + '\\n';
          if (data.success) output.value += '\\n✅ 系统自动更新成功！请稍候刷新页面即可生效。';
        } catch (err) {
          output.value += '[错误] ' + err.message + '\\n';
        }
        output.scrollTop = output.scrollHeight;
      });

      // KV 设置区（参考 ENV 设置区，勾选才展开）
      const kvContainer = document.getElementById('kvContainer');
      document.getElementById('enableKv').addEventListener('change', function () {
        kvContainer.style.display = this.checked ? 'block' : 'none';
        if (this.checked && document.getElementById('kvList').children.length === 0) addKvRow();
      });
      document.getElementById('btnAddKv').addEventListener('click', (e) => {
        e.preventDefault();
        addKvRow();
      });

      function addKvRow() {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:6px; margin-bottom:8px; align-items:center;';
        div.innerHTML = \`
          <input type="text" class="kv-binding" placeholder="KV变量(如KV)" style="flex:2;">
          <input type="text" class="kv-repo" placeholder="KV仓库名" style="flex:3;">
          <select class="kv-action" style="flex:1; padding:10px 4px;"><option value="keep">保留</option><option value="clear">清空</option></select>
          <button type="button" class="btn-icon r-kv-btn" style="color:#ef4444" title="删除">✖</button>
        \`;
        div.querySelector('.r-kv-btn').addEventListener('click', () => div.remove());
        document.getElementById('kvList').appendChild(div);
      }

      // ENV 设置区
      const envContainer = document.getElementById('envContainer');
      document.getElementById('enableEnv').addEventListener('change', function () {
        envContainer.style.display = this.checked ? 'block' : 'none';
        if (this.checked && document.getElementById('envList').children.length === 0) addEnvRow();
      });
      document.getElementById('btnAddEnv').addEventListener('click', (e) => {
        e.preventDefault();
        addEnvRow();
      });

      function addEnvRow() {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:6px; margin-bottom:8px; align-items:center;';
        div.innerHTML = \`
          <input type="text" class="env-name" placeholder="变量名(大写)" style="flex:2;">
          <input type="text" class="env-value" placeholder="变量值" style="flex:3;">
          <select class="env-action" style="flex:1; padding:10px 4px;"><option value="keep">保留原值</option><option value="replace">使用新值</option></select>
          <button type="button" class="btn-icon r-env-btn" style="color:#ef4444" title="删除">✖</button>
        \`;
        div.querySelector('.r-env-btn').addEventListener('click', () => div.remove());
        document.getElementById('envList').appendChild(div);
      }

      document.querySelectorAll('.accordion-header').forEach(h => h.addEventListener('click', function () {
        const target = document.getElementById(this.dataset.target);
        const isActive = target.classList.contains('active');
        document.querySelectorAll('.accordion-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.accordion-header .arrow').forEach(a => a.textContent = '▼');
        if (!isActive) { target.classList.add('active'); this.querySelector('.arrow').textContent = '▲'; }
      }));

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
      }

      function updateMonitorBanner(lines) {
        const bar = document.getElementById('cfDomainMonitor');
        if (lines && lines.length > 0) {
          bar.innerHTML = lines.map(escapeHtml).join('<br>');
          bar.classList.add('active');
        } else {
          bar.innerHTML = '';
          bar.classList.remove('active');
        }
      }

      async function runDeploy(type) {
        const accountId = document.getElementById('accountId').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const name = document.getElementById('projectName').value.trim();
        const src = document.getElementById(type === 'worker' ? 'workerCodeUrl' : 'pagesZipUrl').value.trim();
        const customDomain = type === 'worker' ? document.getElementById('workerCustomDomain').value.trim() : '';
        const enableCfDomain = type === 'worker' ? document.getElementById('workerEnableCfDomain').checked : false;
        if (!accountId || !apiToken || !name) return alert('请填写必填项');

        let kvs = [];
        if (document.getElementById('enableKv').checked) {
          document.querySelectorAll('#kvList > div').forEach(row => {
            const binding = row.querySelector('.kv-binding').value.trim();
            const repo = row.querySelector('.kv-repo').value.trim();
            const action = row.querySelector('.kv-action').value;
            if (repo || binding) kvs.push({ binding, name: repo, action });
          });
        }
        const firstKv = kvs[0] || { binding: '', name: '', action: 'keep' };

        let envs = [];
        if (document.getElementById('enableEnv').checked) {
          document.querySelectorAll('#envList > div').forEach(row => {
            const envName = row.querySelector('.env-name').value.trim();
            const envValue = row.querySelector('.env-value').value.trim();
            const envAction = row.querySelector('.env-action').value;
            if (envName) envs.push({ name: envName, value: envValue, action: envAction });
          });
        }

        updateMonitorBanner([]);
        const output = document.getElementById('logOutput');
        output.value = '部署中...\\n'; output.scrollTop = output.scrollHeight;

        const payload = type === 'worker'
          ? {
              accountId, apiToken,
              kvBinding: firstKv.binding, kvName: firstKv.name, kvAction: firstKv.action, kvs,
              workerName: name, codeUrl: src, envs, customDomain, cfDomain: enableCfDomain, triggerSource: '单次部署'
            }
          : {
              accountId, apiToken,
              kvBinding: firstKv.binding, kvName: firstKv.name, kvAction: firstKv.action, kvs,
              projectName: name, zipUrl: src, envs, triggerSource: '单次部署'
            };

        const res = await fetch(type === 'worker' ? '/api/deploy-worker' : '/api/deploy-pages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await res.json();
        output.value = (data.logs || []).join('\\n'); output.scrollTop = output.scrollHeight;

        const monitorLines = [];
        if (data.success) {
          if (type === 'worker' && enableCfDomain && data.cfDomain) {
            monitorLines.push('🌐 CF域名已开启（Production 开启 / Preview 关闭）：' + data.cfDomain);
          } else if (type === 'pages' && data.cfDomain) {
            monitorLines.push('🌐 Pages 域名：' + data.cfDomain);
          }
          if (Array.isArray(data.customDomains) && data.customDomains.length > 0) {
            monitorLines.push('🔗 已绑定自定义域名：' + data.customDomains.join(', '));
          }
        }
        updateMonitorBanner(monitorLines);
      }
      document.getElementById('btnDeployWorker').addEventListener('click', () => runDeploy('worker'));
      document.getElementById('btnDeployPages').addEventListener('click', () => runDeploy('pages'));
    })();
  </script>
</body></html>`;
}

// ==================== 常用部署页面 ====================
function getDashboardPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>常用部署</title><style>${GLOBAL_STYLE}
    .account-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; background: #fff; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
    .account-header { background: #fafbfc; padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; transition: 0.2s; }
    .account-header:hover { background: #f1f2f6; }
    .account-name { font-size: 14px; font-weight: 600; color: #1e293b; }
    .account-domain-tag { font-size: 11px; color: #64748b; background: #e2e8f0; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: normal; }
    .account-cf-tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 6px; font-weight: 500; }
    .account-cf-tag.on { color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; }
    .account-cf-tag.off { color: #64748b; background: #f1f5f9; }

    .project-list { display: none; padding: 12px; border-top: 1px solid var(--border); }
    .project-list.active { display: block; }

    .project-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
    .project-column { background: #fff; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; min-width: 0; }
    .column-header { background: #f8fafc; padding: 10px 12px; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; border-bottom: 1px solid var(--border); }
    .column-content { padding: 4px 10px 10px 10px; }

    .project-item { padding: 8px 0; border-bottom: 1px solid #f1f2f6; }
    .project-item:last-child { border-bottom: none; }
    .project-title { display: flex; align-items: center; cursor: pointer; font-size: 13px; color: #334155; }
    .project-details { display: none; margin-top: 4px; padding-left: 24px; font-size: 11px; color: #94a3b8; line-height: 1.5; word-break: break-all; }
    .project-details.active { display: block; }

    .temp-deploy-block { background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: 8px; align-items: center; }
    .temp-cb-wrap { font-size: 13px; font-weight: 500; color: #475569; display: flex; align-items: center; }

    .cf-monitor-box { display: none; margin-bottom: 10px; padding: 10px 12px; border-radius: 8px; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; font-size: 12px; line-height: 1.6; word-break: break-all; }
    .cf-monitor-box.active { display: block; }

    .deploy-btn { width: 100%; padding: 12px; font-size: 15px; margin-top: 15px; }
    @media (max-width: 600px) {
      .project-columns { gap: 6px; }
      .column-header { padding: 8px; font-size: 12px; }
      .project-title { font-size: 12px; }
      .temp-deploy-block { grid-template-columns: 1fr 1fr; }
    }
  </style></head><body>
  <div class="container">
    <div class="card">
      <h2>📋 常用部署清单</h2>
      <div id="accountList"></div>
      <button id="btnDeploySelected" class="btn-primary deploy-btn">一键部署所选项目</button>
      <div style="margin-top: 15px;">
        <div id="cfMonitorBox" class="cf-monitor-box"></div>
        <textarea id="logOutput" readonly placeholder="监视窗口与日志将在此输出..."></textarea>
      </div>
      <div class="nav-links">
        <a href="/accounts">⚙️ 账户设置</a>
        <a href="/records">📜 部署记录</a>
        <a href="/">🏠 返回主页</a>
        <a href="/logout" class="danger-link">🚪 退出登录</a>
      </div>
    </div>
  </div>
  <script>
    let allAccounts = [];
    let allWorkerProjects = [];
    let allPageProjects = [];

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) {
        allAccounts = data.accounts || [];
        allWorkerProjects = data.workerProjects || [];
        allPageProjects = data.pageProjects || [];
        renderAccounts();
      }
    }
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text || ''; return div.innerHTML; }

    function extractProjectKvs(proj) {
      if (Array.isArray(proj.kvs) && proj.kvs.length > 0) {
        return proj.kvs.filter(k => k && (k.name || k.binding)).map(k => ({
          binding: String(k.binding || '').trim(),
          name: String(k.name || '').trim(),
          action: k.action === 'clear' ? 'clear' : 'keep'
        }));
      }
      if ((proj.kvName && proj.kvName.trim()) || (proj.kvBinding && proj.kvBinding.trim())) {
        return [{
          binding: String(proj.kvBinding || '').trim(),
          name: String(proj.kvName || '').trim(),
          action: proj.kvAction === 'clear' ? 'clear' : 'keep'
        }];
      }
      return [];
    }

    function getGroupAttachedProjects(account, type) {
      if (type === 'worker') {
        const ids = Array.isArray(account.attachedWorkers) ? account.attachedWorkers : [];
        return ids.map(id => allWorkerProjects.find(w => w.id === id)).filter(w => w && w.show !== false);
      } else {
        const ids = Array.isArray(account.attachedPages) ? account.attachedPages : [];
        return ids.map(id => allPageProjects.find(p => p.id === id)).filter(p => p && p.show !== false);
      }
    }

    function renderAccounts() {
      const container = document.getElementById('accountList');
      container.innerHTML = '';
      let visibleCount = 0;

      allAccounts.forEach((account, accIndex) => {
        if (account.show === false) return;
        visibleCount++;
        const activeWorkers = getGroupAttachedProjects(account, 'worker');
        const activePages = getGroupAttachedProjects(account, 'page');
        const domainBadge = account.domain ? '<span class="account-domain-tag">' + escapeHtml(account.domain) + '</span>' : '';
        const cfBadge = account.cfDomain === true
          ? '<span class="account-cf-tag on">CF域名: 开启(Prod开/Prev关)</span>'
          : '<span class="account-cf-tag off">CF域名: 关闭</span>';

        const accDiv = document.createElement('div');
        accDiv.className = 'account-item';
        accDiv.innerHTML =
          '<div class="account-header" data-acc-index="' + accIndex + '">' +
            '<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;"><input type="checkbox" class="account-checkbox" data-acc-index="' + accIndex + '"><span class="account-name">' + escapeHtml(account.identifier) + '</span>' + domainBadge + cfBadge + '</div>' +
            '<span class="arrow" style="color:#94a3b8; font-size:12px;">▼</span>' +
          '</div>' +
          '<div class="project-list">' +
            '<div class="project-columns">' +
              '<div class="project-column">' +
                '<div class="column-header" data-acc-index="' + accIndex + '" data-group="worker"><input type="checkbox" class="group-checkbox" data-acc-index="' + accIndex + '" data-group="worker"> 🚀 Workers</div>' +
                '<div class="column-content">' + renderProjects(activeWorkers, 'worker', accIndex, account) + '</div>' +
              '</div>' +
              '<div class="project-column">' +
                '<div class="column-header" data-acc-index="' + accIndex + '" data-group="page"><input type="checkbox" class="group-checkbox" data-acc-index="' + accIndex + '" data-group="page"> 📄 Pages</div>' +
                '<div class="column-content">' + renderProjects(activePages, 'page', accIndex, account) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="temp-deploy-block">' +
              '<label class="temp-cb-wrap"><input type="checkbox" class="temp-checkbox" data-acc-index="' + accIndex + '"> 临时部署</label>' +
              '<select class="temp-type" data-acc-index="' + accIndex + '"><option value="worker">Worker</option><option value="page">Pages</option></select>' +
              '<input type="text" class="temp-name" data-acc-index="' + accIndex + '" placeholder="项目名称">' +
              '<input type="text" class="temp-kv-binding" data-acc-index="' + accIndex + '" placeholder="KV变量">' +
              '<input type="text" class="temp-kv" data-acc-index="' + accIndex + '" placeholder="KV仓库">' +
              '<select class="temp-kv-action" data-acc-index="' + accIndex + '" disabled><option value="keep">保留</option><option value="clear">清空</option></select>' +
              '<input type="text" class="temp-source" data-acc-index="' + accIndex + '" placeholder="源地址(可选)">' +
              '<div class="temp-env-wrap" style="grid-column: 1 / -1; margin-top: 5px; border-top: 1px dashed #e2e8f0; padding-top: 8px;">' +
                '<label class="temp-cb-wrap" style="margin-bottom:6px; cursor:pointer;"><input type="checkbox" class="temp-env-cb" data-acc-index="' + accIndex + '"> 为本组选中项目附加组 ENV</label>' +
                '<div class="temp-env-list" data-acc-index="' + accIndex + '" style="display:none; flex-direction:column; gap:6px;"></div>' +
                '<button class="add-env-btn" data-acc-index="' + accIndex + '" style="display:none; background:#e2e8f0; color:#475569; padding:4px 8px; font-size:12px; border-radius:4px; border:none; cursor:pointer; margin-top:6px;">➕ 增加变量</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        container.appendChild(accDiv);
      });

      if (visibleCount === 0) { container.innerHTML = '<p style="text-align:center; color:#94a3b8; font-size:13px; margin:20px 0;">暂无显示的账户，请前往设置添加。</p>'; return; }

      document.querySelectorAll('.account-header').forEach(h => h.addEventListener('click', function (e) {
        if (e.target.tagName === 'INPUT') return;
        const list = this.nextElementSibling;
        list.classList.toggle('active');
        this.querySelector('.arrow').textContent = list.classList.contains('active') ? '▲' : '▼';
      }));
      document.querySelectorAll('.project-title').forEach(t => t.addEventListener('click', function (e) {
        if (e.target.tagName === 'INPUT') return;
        this.nextElementSibling.classList.toggle('active');
      }));

      function addDashboardEnvRow(listNode, name = '', val = '', action = 'keep') {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:6px; align-items:center;';
        div.innerHTML = '<input type="text" class="e-name" placeholder="变量名(如API_KEY)" value="' + escapeHtml(name) + '" style="flex:2; font-size:12px; padding:6px;">' +
                        '<input type="text" class="e-val" placeholder="变量值" value="' + escapeHtml(val) + '" style="flex:3; font-size:12px; padding:6px;">' +
                        '<select class="e-act" style="flex:1; font-size:12px; padding:6px;">' +
                          '<option value="keep" ' + (action === 'keep' ? 'selected' : '') + '>同名保留原值</option>' +
                          '<option value="replace" ' + (action === 'replace' ? 'selected' : '') + '>同名使用新值</option>' +
                        '</select>' +
                        '<span class="r-env" style="color:#ef4444; cursor:pointer; font-size:14px; padding:4px;" title="删除">✖</span>';
        div.querySelector('.r-env').addEventListener('click', () => div.remove());
        listNode.appendChild(div);
      }

      document.querySelectorAll('.temp-env-cb').forEach(cb => cb.addEventListener('change', function () {
        const idx = parseInt(this.dataset.accIndex);
        const list = document.querySelector('.temp-env-list[data-acc-index="' + idx + '"]');
        const btn = document.querySelector('.add-env-btn[data-acc-index="' + idx + '"]');
        list.style.display = this.checked ? 'flex' : 'none';
        btn.style.display = this.checked ? 'inline-block' : 'none';

        if (this.checked && list.children.length === 0) {
          const account = allAccounts[idx];
          if (account.envs && account.envs.length > 0) {
            account.envs.forEach(env => addDashboardEnvRow(list, env.name, env.value, env.action));
          } else {
            addDashboardEnvRow(list);
          }
        }
      }));

      document.querySelectorAll('.add-env-btn').forEach(btn => btn.addEventListener('click', function (e) {
        e.preventDefault();
        const list = document.querySelector('.temp-env-list[data-acc-index="' + this.dataset.accIndex + '"]');
        addDashboardEnvRow(list);
      }));

      document.querySelectorAll('.temp-kv').forEach(input => input.addEventListener('input', function () {
        const sel = document.querySelector('.temp-kv-action[data-acc-index="' + this.dataset.accIndex + '"]');
        if (sel) sel.disabled = !this.value.trim();
      }));
      document.querySelectorAll('.account-checkbox').forEach(cb => cb.addEventListener('change', function () {
        const idx = this.dataset.accIndex;
        document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"], .group-checkbox[data-acc-index="' + idx + '"]').forEach(c => c.checked = this.checked);
      }));
      document.querySelectorAll('.column-header').forEach(header => header.addEventListener('click', function (e) {
        const cb = this.querySelector('.group-checkbox');
        if (e.target.tagName !== 'INPUT') cb.checked = !cb.checked;
        document.querySelectorAll('.normal-checkbox[data-acc-index="' + this.dataset.accIndex + '"][data-type="' + this.dataset.group + '"]').forEach(c => c.checked = cb.checked);
        checkAccountSync(this.dataset.accIndex);
      }));
      document.querySelectorAll('.normal-checkbox').forEach(cb => cb.addEventListener('change', function () {
        checkGroupSync(this.dataset.accIndex, this.dataset.type);
        checkAccountSync(this.dataset.accIndex);
      }));

      function checkGroupSync(idx, type) {
        const all = document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"][data-type="' + type + '"]');
        const checked = document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"][data-type="' + type + '"]:checked');
        const gcb = document.querySelector('.group-checkbox[data-acc-index="' + idx + '"][data-group="' + type + '"]');
        if (gcb) gcb.checked = (all.length > 0 && all.length === checked.length);
      }
      function checkAccountSync(idx) {
        const all = document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"]');
        const checked = document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"]:checked');
        const accCb = document.querySelector('.account-checkbox[data-acc-index="' + idx + '"]');
        if (accCb) accCb.checked = (all.length > 0 && all.length === checked.length);
      }
    }

    function renderProjects(projects, type, accIndex, account) {
      if (!projects || projects.length === 0) return '<div style="padding:10px 0; color:#cbd5e1; text-align:center; font-size:12px;">未附加项目</div>';
      return projects.map(proj => {
        const kvList = extractProjectKvs(proj);
        const kvDisp = kvList.length > 0
          ? kvList.map(k => (k.binding || '(原KV变量)') + ' -> ' + (k.name || '(未填仓库)') + ' (' + (k.action === 'clear' ? '清空' : '保留') + ')').join(' ; ')
          : '(留空/保留原有关系)';

        let domainInfo = '';
        if (type === 'worker' && proj.subdomain && account.domain) {
          const fullDomain = proj.subdomain.trim() + '.' + account.domain.trim();
          domainInfo = '<div>自定义域: <span style="color:#10b981;">' + escapeHtml(fullDomain) + '</span></div>';
        } else if (type === 'worker' && proj.subdomain && !account.domain) {
          domainInfo = '<div>自定义域: <span style="color:#f59e0b;">子域 ' + escapeHtml(proj.subdomain) + ' (组未设根域名)</span></div>';
        }

        const projEnvCount = Array.isArray(proj.envs) ? proj.envs.filter(e => e.name).length : 0;
        const envInfo = projEnvCount > 0 ? '<div>独立ENV: ' + projEnvCount + ' 项</div>' : '';

        return '<div class="project-item">' +
          '<div class="project-title"><input type="checkbox" class="project-checkbox normal-checkbox" data-acc-index="' + accIndex + '" data-type="' + type + '" data-proj-id="' + escapeHtml(proj.id) + '">' +
          '<span class="name">' + escapeHtml(proj.name) + '</span></div>' +
          '<div class="project-details"><div>KV: ' + escapeHtml(kvDisp) + '</div>' + domainInfo + envInfo + '<div>源: ' + escapeHtml(proj.codeUrl || '默认') + '</div></div></div>';
      }).join('');
    }

    function mergeEnvs(groupEnvs, projectEnvs) {
      const map = new Map();
      (groupEnvs || []).forEach(e => {
        if (e && e.name) map.set(e.name, { name: e.name, value: e.value, action: e.action || 'keep' });
      });
      (projectEnvs || []).forEach(e => {
        if (e && e.name) map.set(e.name, { name: e.name, value: e.value, action: e.action || 'keep' });
      });
      return Array.from(map.values());
    }

    document.getElementById('btnDeploySelected').addEventListener('click', async function () {
      const btn = this, output = document.getElementById('logOutput'), cfBox = document.getElementById('cfMonitorBox'), selected = [];
      document.querySelectorAll('.normal-checkbox:checked, .temp-checkbox:checked').forEach(cb => {
        const accIndex = parseInt(cb.dataset.accIndex), account = allAccounts[accIndex];
        if (cb.classList.contains('temp-checkbox')) {
          const type = document.querySelector('.temp-type[data-acc-index="' + accIndex + '"]').value;
          const name = document.querySelector('.temp-name[data-acc-index="' + accIndex + '"]').value.trim();
          const kvBinding = document.querySelector('.temp-kv-binding[data-acc-index="' + accIndex + '"]').value.trim();
          const kvName = document.querySelector('.temp-kv[data-acc-index="' + accIndex + '"]').value.trim();
          const kvAction = document.querySelector('.temp-kv-action[data-acc-index="' + accIndex + '"]').value;
          const codeUrl = document.querySelector('.temp-source[data-acc-index="' + accIndex + '"]').value.trim();
          const kvs = (kvName || kvBinding) ? [{ binding: kvBinding, name: kvName, action: kvAction }] : [];
          if (name) selected.push({ type, account, proj: { name, kvBinding, kvName, kvAction, kvs, codeUrl: codeUrl || 'default', envs: [] } });
        } else {
          const type = cb.dataset.type, projId = cb.dataset.projId;
          const proj = type === 'worker' ? allWorkerProjects.find(w => w.id === projId) : allPageProjects.find(p => p.id === projId);
          if (proj) selected.push({ type, account, proj });
        }
      });
      if (selected.length === 0) return alert('请先勾选需要部署的项目');

      btn.disabled = true; output.value = '开始批量部署...\\n';
      cfBox.innerHTML = ''; cfBox.classList.remove('active');
      const monitorSummaryItems = [];

      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        output.value += '\\n[' + (i + 1) + '/' + selected.length + '] ' + item.account.identifier + ' <- ' + item.proj.name + '\\n';
        output.scrollTop = output.scrollHeight;
        try {
          const currentAccIndex = allAccounts.indexOf(item.account);
          const envCb = document.querySelector('.temp-env-cb[data-acc-index="' + currentAccIndex + '"]');
          let groupEnvs = [];
          if (envCb && envCb.checked) {
            document.querySelectorAll('.temp-env-list[data-acc-index="' + currentAccIndex + '"] > div').forEach(row => {
              const name = row.querySelector('.e-name').value.trim();
              const value = row.querySelector('.e-val').value.trim();
              const action = row.querySelector('.e-act').value;
              if (name) groupEnvs.push({ name, value, action });
            });
          }

          const finalEnvs = mergeEnvs(groupEnvs, item.proj.envs);
          const projKvs = extractProjectKvs(item.proj);
          const firstKv = projKvs[0] || { binding: '', name: '', action: 'keep' };

          let customDomain = '';
          if (item.type === 'worker' && item.proj.subdomain && item.proj.subdomain.trim() && item.account.domain && item.account.domain.trim()) {
            customDomain = item.proj.subdomain.trim() + '.' + item.account.domain.trim();
          }

          const accCfEnabled = item.account.cfDomain === true;
          const payload = {
            type: item.type, id: item.account.accountId, token: item.account.token,
            kvBinding: firstKv.binding, kv: firstKv.name, kvAction: firstKv.action, kvs: projKvs,
            name: item.proj.name, source: item.proj.codeUrl || 'default',
            envs: finalEnvs,
            customDomain: customDomain,
            subdomain: item.proj.subdomain || '',
            cfDomain: accCfEnabled,
            serverLabel: item.account.identifier + ' (' + item.account.accountId + ')',
            triggerSource: '常用部署'
          };
          const res = await fetch('/api/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const data = await res.json();
          output.value += (data.logs || []).join('\\n') + '\\n';

          if (data.success) {
            const parts = [];
            if (item.type === 'worker' && accCfEnabled && data.cfDomain) {
              parts.push('CF域名: ' + data.cfDomain);
            }
            if (Array.isArray(data.customDomains) && data.customDomains.length > 0) {
              parts.push('自定义域名: ' + data.customDomains.join(', '));
            }
            if (parts.length > 0) {
              monitorSummaryItems.push('[' + item.account.identifier + '] ' + item.proj.name + ' -> ' + parts.join(' | '));
            }
          }
        } catch (e) { output.value += '[错误] ' + e.message + '\\n'; }
        output.scrollTop = output.scrollHeight;
      }

      if (monitorSummaryItems.length > 0) {
        cfBox.innerHTML = '<b>🌐 域名状态汇总（CF域名 / 已绑定自定义域名）：</b><br>' + monitorSummaryItems.map(escapeHtml).join('<br>');
        cfBox.classList.add('active');
      }

      output.value += '\\n========== 部署结束 ==========\\n';
      btn.disabled = false;
    });

    loadAccounts();
  </script>
</body></html>`;
}

// ==================== 账户与三区项目配置管理页面 ====================
function getAccountsPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>账户与项目设置</title><style>${GLOBAL_STYLE}
    .action-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .action-bar button { padding: 10px; font-size: 13px; }

    .zone-card { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; background: #fff; overflow: hidden; }
    .zone-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: #fafbfc; cursor: pointer; user-select: none; transition: 0.2s; }
    .zone-header:hover { background: #f1f2f6; }
    .zone-title { font-size: 15px; font-weight: 600; color: #1e293b; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .zone-badge { font-size: 11px; background: #fff7ed; color: var(--primary); border: 1px solid #fed7aa; padding: 2px 8px; border-radius: 99px; font-weight: 500; }
    .zone-header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .zone-arrow { color: #94a3b8; font-size: 12px; width: 16px; text-align: center; }
    .zone-body { display: none; padding: 16px 18px; border-top: 1px solid var(--border); background: #fff; }
    .zone-body.active { display: block; }

    .hidden-proj-wrapper { margin-top: 12px; border: 1px dashed #cbd5e1; border-radius: 8px; background: #f8fafc; overflow: hidden; }
    .hidden-proj-header { padding: 8px 12px; font-size: 12px; font-weight: 500; color: #64748b; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; transition: 0.2s; }
    .hidden-proj-header:hover { background: #f1f5f9; color: #334155; }
    .hidden-proj-body { display: none; padding: 8px 10px; border-top: 1px dashed #cbd5e1; background: #fff; }
    .hidden-proj-body.active { display: block; }

    .account-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; background: #fff; overflow: hidden; }
    .account-item:last-child { margin-bottom: 0; }
    .account-header { background: #fafbfc; padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; transition: 0.2s; }
    .account-header:hover { background: #f1f2f6; }
    .account-header-left { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .account-header-left h3 { font-size: 15px; font-weight: 600; margin: 0; color: #1e293b; }
    .account-header-right { display: flex; gap: 4px; flex-shrink: 0; align-items: center; }

    .project-list { display: none; padding: 15px; border-top: 1px solid var(--border); }
    .project-list.active { display: block; }

    .project-detail { background: #fafbfc; border: 1px solid #eaedf1; padding: 10px 12px; margin: 6px 0; border-radius: 6px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
    .project-detail:first-child { margin-top: 0; }
    .project-detail:last-child { margin-bottom: 0; }
    .project-detail-info { flex: 1; min-width: 0; color: #64748b; line-height: 1.5; }
    .project-detail-info b { color: #334155; font-size: 13px; }
    .project-detail-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 10px; }

    .tag-pill { display: inline-block; font-size: 11px; padding: 2px 7px; border-radius: 4px; background: #f1f5f9; color: #475569; margin-right: 4px; margin-top: 3px; }
    .tag-pill.worker { background: #fff7ed; color: #c2410c; border: 1px solid #ffedd5; }
    .tag-pill.page { background: #eff6ff; color: #1d4ed8; border: 1px solid #dbeafe; }
    .tag-pill.domain { background: #ecfdf5; color: #047857; border: 1px solid #d1fae5; }
    .tag-pill.cf-on { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .tag-pill.cf-off { background: #f1f5f9; color: #64748b; }

    .attach-box { background: #f8fafc; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; max-height: 210px; overflow-y: auto; }
    .attach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
    .attach-item { display: flex; align-items: center; font-size: 13px; color: #334155; cursor: pointer; padding: 4px 6px; border-radius: 4px; background: #fff; border: 1px solid #eaedf1; }
    .attach-item:hover { border-color: var(--primary); }

    .prefix-manage-row { display: flex; gap: 6px; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px 10px; border-radius: 8px; margin-bottom: 8px; }
    .prefix-manage-row input { flex: 1; padding: 7px 10px !important; font-size: 12px !important; background: #fff !important; }

    .form-group { margin-bottom: 12px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 5px; color: #475569; }
    .add-btn { background: #e2e8f0; color: #475569; padding: 8px 12px; font-size: 13px; margin-top: 4px; }
    .add-btn:hover { background: #cbd5e1; }
  </style></head><body>
  <div class="container">
    <div class="card">
      <h2>⚙️ 账户与项目配置管理</h2>

      <div class="action-bar">
        <button id="btnBackup" class="btn-primary" style="background:#10b981;">📦 备份配置</button>
        <button id="btnShowRestore" class="btn-primary" style="background:#f59e0b;">⏪ 恢复配置</button>
        <button id="btnExport" class="btn-primary" style="background:#8b5cf6;">📤 导出全部</button>
        <button id="btnImport" class="btn-primary" style="background:#3b82f6;">📥 导入配置</button>
        <input type="file" id="importFile" style="display:none" accept=".json">
      </div>

      <!-- ==================== 第一区：服务器设置（账户组） ==================== -->
      <div class="zone-card">
        <div class="zone-header" data-zone="zone1Body">
          <div class="zone-title">🖥️ 服务器设置 <span class="zone-badge" id="zone1Count">0 组</span></div>
          <div class="zone-header-right">
            <button id="btnAddAccount" class="btn-primary" style="padding: 6px 12px; font-size: 12px;">➕ 添加服务器组</button>
            <span class="zone-arrow">▼</span>
          </div>
        </div>
        <div id="zone1Body" class="zone-body">
          <div id="accountList"></div>
        </div>
      </div>

      <!-- ==================== 第二区：Worker 项目区 ==================== -->
      <div class="zone-card">
        <div class="zone-header" data-zone="zone2Body">
          <div class="zone-title">🚀 Worker 项目区 <span class="zone-badge" id="zone2Count">0 项</span></div>
          <div class="zone-header-right">
            <button id="btnAddGlobalWorker" class="btn-primary" style="padding: 6px 12px; font-size: 12px;">➕ 新增 Worker 项目</button>
            <span class="zone-arrow">▼</span>
          </div>
        </div>
        <div id="zone2Body" class="zone-body">
          <div id="globalWorkerList"></div>
        </div>
      </div>

      <!-- ==================== 第三区：Pages 项目区 ==================== -->
      <div class="zone-card">
        <div class="zone-header" data-zone="zone3Body">
          <div class="zone-title">📄 Pages 项目区 <span class="zone-badge" id="zone3Count">0 项</span></div>
          <div class="zone-header-right">
            <button id="btnAddGlobalPage" class="btn-primary" style="padding: 6px 12px; font-size: 12px;">➕ 新增 Pages 项目</button>
            <span class="zone-arrow">▼</span>
          </div>
        </div>
        <div id="zone3Body" class="zone-body">
          <div id="globalPageList"></div>
        </div>
      </div>

      <!-- ==================== 缺省地址前缀模块 ==================== -->
      <div class="zone-card" style="margin-bottom: 0;">
        <div class="zone-header" data-zone="zonePrefixBody">
          <div class="zone-title">🔗 缺省地址前缀 <span class="zone-badge" id="prefixCountBadge">0 个</span></div>
          <div class="zone-header-right">
            <span class="zone-arrow">▼</span>
          </div>
        </div>
        <div id="zonePrefixBody" class="zone-body">
          <div style="display:flex; align-items:center; gap:8px;">
            <select id="sysDefaultPrefixSelect" style="flex:1;">
              <option value="">（无缺省前缀）</option>
            </select>
            <button id="btnOpenPrefixModal" class="btn-primary" style="padding: 9px 14px; font-size: 13px; flex-shrink: 0;">⚙️ 设置</button>
          </div>
          <p style="font-size:12px; color:#94a3b8; margin-top:8px; line-height: 1.5;">
            部署时，若填写的源地址未以 http/https 开头，将自动在前面拼接当前选中的缺省前缀。<br>
            点击右侧“设置”可对前缀进行新增、修改、删除与排序；新增或保存前缀时，若末尾不是 "/" 将自动补充。
          </p>
        </div>
      </div>

      <div class="nav-links">
        <a href="/dashboard">📋 常用部署</a>
        <a href="/records">📜 部署记录</a>
        <a href="/">🏠 返回主页</a>
      </div>
    </div>
  </div>

  <!-- 缺省地址前缀设置弹窗 -->
  <div id="prefixModal" class="modal">
    <div class="modal-content" style="max-width: 560px;">
      <h3 style="margin-bottom:14px; font-size:16px;">🔗 缺省地址前缀设置</h3>
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        <input type="text" id="newPrefixInput" placeholder="输入前缀，如 https://raw.githubusercontent.com/用户/库/main（未填末尾/将自动补充）" style="flex:1;">
        <button id="btnAddPrefixItem" class="btn-primary" style="padding:0 14px; font-size:13px; flex-shrink:0;">➕ 添加</button>
      </div>
      <div id="prefixManageList" style="max-height: 300px; overflow-y: auto;"></div>
      <div style="display:flex; gap:10px; margin-top:18px;">
        <button id="btnSavePrefixModal" class="btn-primary" style="flex:1; padding:10px;">保存设置</button>
        <button id="btnCancelPrefixModal" class="btn-danger" style="flex:1; padding:10px; background:#f1f5f9; color:#475569;">取消</button>
      </div>
    </div>
  </div>

  <!-- 第一区：服务器组编辑弹窗 -->
  <div id="editModal" class="modal">
    <div class="modal-content">
      <h3 id="modalTitle" style="margin-bottom:15px; font-size:16px;">编辑服务器组</h3>
      <div class="form-group"><label>组标识名称</label><input type="text" id="editIdentifier" placeholder="任意自定义名称"></div>
      <div class="form-group"><label>Account ID</label><input type="text" id="editAccountId"></div>
      <div class="form-group"><label>API Token</label>
        <div class="pwd-wrap">
          <input type="password" id="editToken">
          <div class="pwd-toggle" onclick="togglePwd(this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></div>
        </div>
      </div>
      <div class="form-group"><label>组项目域名（可选，用于拼接 Worker 自定义子域）</label><input type="text" id="editDomain" placeholder="例如：example.com（无需填 http://）"></div>

      <div class="form-group" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 12px;">
        <label style="display:flex; align-items:center; cursor:pointer; color:#1e293b; margin-bottom:2px;">
          <input type="checkbox" id="editCfDomain"> CF域名
        </label>
        <div style="font-size:11px; color:#64748b; padding-left:22px;">选取后开启 CF 提供的 workers.dev 域名（Production 开启与 Preview 关闭），否则关闭 workers.dev 域名（Production 与 Preview 都关闭）。</div>
      </div>

      <div class="form-group" style="border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; margin-top: 10px; background:#fafbfc;">
        <label style="color:#334155; margin-bottom:5px;">默认组环境变量 (ENV) <span style="font-size:11px;color:#94a3b8;font-weight:normal;">会在常用部署页面自动加载</span></label>
        <div id="accEnvList" style="display:flex; flex-direction:column; gap:6px;"></div>
        <button id="btnAddAccEnv" class="add-btn" style="width:auto; margin-top:8px;">➕ 添加组变量</button>
      </div>

      <div class="form-group">
        <label>🚀 附加 Worker 项目（勾选需要在此服务器组部署的项目）</label>
        <div id="attachWorkerBox" class="attach-box"></div>
      </div>

      <div class="form-group">
        <label>📄 附加 Pages 项目（勾选需要在此服务器组部署的项目）</label>
        <div id="attachPageBox" class="attach-box"></div>
      </div>

      <div class="form-group"><label style="display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="editAccountShow" checked> 在常用部署页显示此服务器组</label></div>

      <div style="display:flex; gap:10px; margin-top:20px;">
        <button id="btnSave" class="btn-primary" style="flex:1; padding:10px;">保存</button>
        <button id="btnCancel" class="btn-danger" style="flex:1; padding:10px; background:#f1f5f9; color:#475569;">取消</button>
      </div>
    </div>
  </div>

  <!-- 第二区 & 第三区：全局 Worker / Pages 项目配置弹窗（KV 设置区参考 ENV 设置区设计） -->
  <div id="projModal" class="modal">
    <div class="modal-content" style="max-width: 620px;">
      <h3 id="projModalTitle" style="margin-bottom:15px; font-size:16px;">配置项目</h3>
      <div class="form-group"><label>项目名称（Worker 脚本名 / Pages 项目名）</label><input type="text" id="pName" placeholder="例如：my-app"></div>

      <div class="form-group" style="border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; background:#fafbfc;">
        <label style="color:#334155; margin-bottom:5px;">KV 绑定设置 (KV) <span style="font-size:11px;color:#94a3b8;font-weight:normal;">可绑定多个 KV 变量对应不同仓库，留空保留原有绑定</span></label>
        <div id="projKvList" style="display:flex; flex-direction:column; gap:6px;"></div>
        <button type="button" id="btnAddProjKv" class="add-btn" style="width:auto; margin-top:8px;">➕ 添加 KV</button>
      </div>

      <div class="form-group"><label id="pUrlLabel">代码源 / ZIP 地址</label><input type="text" id="pCodeUrl" placeholder="留空使用默认源，或填写相对路径/完整URL"></div>

      <div class="form-group" id="pSubdomainWrap">
        <label>自定义子域名（可选，仅 Worker 生效）</label>
        <input type="text" id="pSubdomain" placeholder="例如：api（部署时自动拼接为 api.该组项目域名）">
      </div>

      <div class="form-group" style="border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; background:#fafbfc;">
        <label style="color:#334155; margin-bottom:5px;">项目独立环境变量 (ENV) <span style="font-size:11px;color:#94a3b8;font-weight:normal;">同名变量优先覆盖组 ENV</span></label>
        <div id="projEnvList" style="display:flex; flex-direction:column; gap:6px;"></div>
        <button type="button" id="btnAddProjEnv" class="add-btn" style="width:auto; margin-top:8px;">➕ 添加项目变量</button>
      </div>

      <div class="form-group"><label style="display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="pShow" checked> 在常用部署中启用显示</label></div>

      <div style="display:flex; gap:10px; margin-top:20px;">
        <button id="btnSaveProj" class="btn-primary" style="flex:1; padding:10px;">保存项目</button>
        <button id="btnCancelProj" class="btn-danger" style="flex:1; padding:10px; background:#f1f5f9; color:#475569;">取消</button>
      </div>
    </div>
  </div>

  <!-- 恢复备份弹窗 -->
  <div id="restoreModal" class="modal">
    <div class="modal-content" style="max-width: 400px;">
      <h3 style="margin-bottom:15px; font-size:16px;">📂 选择备份进行恢复</h3>
      <div class="form-group">
        <select id="backupSelect"></select>
        <small style="color:#e74c3c; display:block; margin-top:8px;">警告：恢复将覆盖当前所有配置！</small>
      </div>
      <div style="display:flex; gap:10px; margin-top:15px;">
        <button id="btnConfirmRestore" class="btn-primary" style="background:#f59e0b; flex:1;">确认恢复</button>
        <button id="btnCancelRestore" class="btn-danger" style="background:#f1f5f9; color:#475569; flex:1;">取消</button>
      </div>
    </div>
  </div>

  <script>
    ${GLOBAL_SCRIPT}
    const ICONS = ${JSON.stringify(ICONS)};
    let accounts = [];
    let workerProjects = [];
    let pageProjects = [];
    let sysDefaultPrefix = "";
    let prefixList = [];
    let draftPrefixes = [];
    let editingIdentifier = null;
    let editingProjType = 'worker';
    let editingProjId = null;

    const collapseState = {
      zone1Body: false,
      zone2Body: false,
      zone3Body: false,
      zonePrefixBody: false,
      hiddenWorker: false,
      hiddenPage: false
    };

    function ensureTrailingSlash(val) {
      const s = String(val || '').trim();
      if (!s) return '';
      return s.endsWith('/') ? s : s + '/';
    }

    function setZoneExpanded(zoneId, expanded) {
      const body = document.getElementById(zoneId);
      const header = document.querySelector('.zone-header[data-zone="' + zoneId + '"]');
      if (!body || !header) return;
      collapseState[zoneId] = expanded;
      if (expanded) {
        body.classList.add('active');
        header.querySelector('.zone-arrow').textContent = '▲';
      } else {
        body.classList.remove('active');
        header.querySelector('.zone-arrow').textContent = '▼';
      }
    }

    document.querySelectorAll('.zone-header').forEach(header => {
      header.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        const zoneId = this.dataset.zone;
        setZoneExpanded(zoneId, !collapseState[zoneId]);
      });
    });

    function renderPrefixDropdown() {
      const sel = document.getElementById('sysDefaultPrefixSelect');
      const badge = document.getElementById('prefixCountBadge');
      if (badge) badge.textContent = prefixList.length + ' 个';
      if (!sel) return;
      sel.innerHTML = '<option value="">（无缺省前缀）</option>';
      prefixList.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        if (p === sysDefaultPrefix) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) {
        accounts = data.accounts || [];
        workerProjects = data.workerProjects || [];
        pageProjects = data.pageProjects || [];
        prefixList = Array.isArray(data.prefixes) ? data.prefixes.map(ensureTrailingSlash).filter(Boolean) : [];
        sysDefaultPrefix = ensureTrailingSlash(data.defaultPrefix || "");
        if (sysDefaultPrefix && !prefixList.includes(sysDefaultPrefix)) {
          prefixList.unshift(sysDefaultPrefix);
        }
        renderPrefixDropdown();
        renderAll();
      }
    }

    async function saveAccountsOrder() {
      await fetch('/api/accounts/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts }) });
      renderAccounts();
    }

    async function saveGlobalProjectsToServer() {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerProjects, pageProjects })
      });
      return await res.json();
    }

    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text || ''; return div.innerHTML; }
    function moveArrItem(arr, idx, dir) { const t = idx + dir; if (t < 0 || t >= arr.length) return false; [arr[idx], arr[t]] = [arr[t], arr[idx]]; return true; }

    function getProjectKvList(p) {
      if (Array.isArray(p.kvs) && p.kvs.length > 0) {
        return p.kvs.filter(k => k && (k.name || k.binding)).map(k => ({
          binding: String(k.binding || '').trim(),
          name: String(k.name || '').trim(),
          action: k.action === 'clear' ? 'clear' : 'keep'
        }));
      }
      if ((p.kvName && p.kvName.trim()) || (p.kvBinding && p.kvBinding.trim())) {
        return [{
          binding: String(p.kvBinding || '').trim(),
          name: String(p.kvName || '').trim(),
          action: p.kvAction === 'clear' ? 'clear' : 'keep'
        }];
      }
      return [];
    }

    function renderAll() {
      document.getElementById('zone1Count').textContent = accounts.length + ' 组';
      document.getElementById('zone2Count').textContent = workerProjects.length + ' 项';
      document.getElementById('zone3Count').textContent = pageProjects.length + ' 项';
      renderAccounts();
      renderGlobalProjects('worker');
      renderGlobalProjects('page');
    }

    // ==================== 渲染第一区：服务器组 ====================
    function renderAccounts() {
      const container = document.getElementById('accountList');
      container.innerHTML = '';
      if (accounts.length === 0) { container.innerHTML = '<p style="text-align:center; color:#94a3b8; font-size:13px; margin:10px 0;">暂无服务器组，请点击右上角添加。</p>'; return; }

      accounts.forEach((acc, accIdx) => {
        const div = document.createElement('div'); div.className = 'account-item';
        const hideTag = acc.show === false ? '<span style="color:#ef4444;font-size:12px;font-weight:normal;">[隐藏]</span>' : '';
        const domainTag = acc.domain ? '<span class="tag-pill domain">' + escapeHtml(acc.domain) + '</span>' : '';
        const cfTag = acc.cfDomain === true
          ? '<span class="tag-pill cf-on">CF域名: 开启(Prod开/Prev关)</span>'
          : '<span class="tag-pill cf-off">CF域名: 关闭</span>';
        const disUp = accIdx === 0 ? 'disabled' : '', disDn = accIdx === accounts.length - 1 ? 'disabled' : '';

        const attachedW = (acc.attachedWorkers || []).map(id => workerProjects.find(w => w.id === id)).filter(Boolean);
        const attachedP = (acc.attachedPages || []).map(id => pageProjects.find(p => p.id === id)).filter(Boolean);

        let htmlStr = '<div class="account-header">' +
          '<div class="account-header-left"><h3>' + escapeHtml(acc.identifier) + '</h3>' + hideTag + domainTag + cfTag + '</div>' +
          '<div class="account-header-right">' +
            '<button class="btn-icon move-acc-up" ' + disUp + ' data-idx="' + accIdx + '">' + ICONS.up + '</button>' +
            '<button class="btn-icon move-acc-down" ' + disDn + ' data-idx="' + accIdx + '">' + ICONS.down + '</button>' +
            '<button class="btn-icon edit-btn" data-id="' + escapeHtml(acc.identifier) + '" style="color:var(--primary)">' + ICONS.edit + '</button>' +
            '<button class="btn-icon delete-btn" data-id="' + escapeHtml(acc.identifier) + '" style="color:#ef4444">' + ICONS.del + '</button>' +
            '<span class="arrow" style="color:#94a3b8; font-size:12px; margin-left:8px;">▼</span>' +
          '</div></div><div class="project-list">';

        let summaryHtml = '<div style="font-size:12px; color:#64748b; margin-bottom:6px;"><b>Account ID:</b> ' + escapeHtml(acc.accountId) + ' | <b>组域名:</b> ' + escapeHtml(acc.domain || '未设置') + ' | <b>CF域名:</b> ' + (acc.cfDomain === true ? '开启 (Production 开 / Preview 关)' : '关闭 (Production 关 / Preview 关)') + '</div>';
        summaryHtml += '<div style="margin-bottom:6px;"><span style="font-size:12px; color:#475569; font-weight:500;">已附加 Workers (' + attachedW.length + ')：</span>' +
          (attachedW.length ? attachedW.map(w => '<span class="tag-pill worker">' + escapeHtml(w.name) + (w.subdomain && acc.domain ? ' (' + escapeHtml(w.subdomain + '.' + acc.domain) + ')' : '') + '</span>').join('') : '<span style="font-size:12px;color:#94a3b8;">无</span>') + '</div>';
        summaryHtml += '<div><span style="font-size:12px; color:#475569; font-weight:500;">已附加 Pages (' + attachedP.length + ')：</span>' +
          (attachedP.length ? attachedP.map(p => '<span class="tag-pill page">' + escapeHtml(p.name) + '</span>').join('') : '<span style="font-size:12px;color:#94a3b8;">无</span>') + '</div>';

        htmlStr += summaryHtml + '</div>';
        div.innerHTML = htmlStr;
        container.appendChild(div);
      });

      document.querySelectorAll('#accountList .account-header').forEach(h => h.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        const list = this.nextElementSibling;
        list.classList.toggle('active');
        const arrow = this.querySelector('.arrow');
        if (arrow) arrow.textContent = list.classList.contains('active') ? '▲' : '▼';
      }));
      document.querySelectorAll('.move-acc-up').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if (moveArrItem(accounts, parseInt(b.dataset.idx), -1)) saveAccountsOrder(); }));
      document.querySelectorAll('.move-acc-down').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if (moveArrItem(accounts, parseInt(b.dataset.idx), 1)) saveAccountsOrder(); }));
      document.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openEditAccount(b.dataset.id); }));
      document.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation(); if (confirm('删除服务器组 ' + b.dataset.id + '？')) { await fetch('/api/accounts?identifier=' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }); loadAccounts(); }
      }));
    }

    function buildProjectDetailElement(p, originalIdx, totalLen, type) {
      const hTag = p.show === false ? '<span style="color:#ef4444">[隐藏]</span> ' : '';
      const kvList = getProjectKvList(p);
      const kvInfo = kvList.length > 0
        ? ('KV: ' + kvList.map(k => (k.binding || '(原KV变量)') + ' -> ' + (k.name || '(未填仓库)') + (k.action === 'clear' ? '(清)' : '')).join(' ; '))
        : '保留原KV关系';
      const subInfo = (type === 'worker' && p.subdomain) ? (' | 子域: <span style="color:#10b981;">' + escapeHtml(p.subdomain) + '</span>') : '';
      const envCount = (p.envs || []).filter(e => e.name).length;
      const envInfo = envCount > 0 ? (' | 独立ENV: ' + envCount + '项') : '';
      const uDis = originalIdx === 0 ? 'disabled' : '', dDis = originalIdx === totalLen - 1 ? 'disabled' : '';

      const div = document.createElement('div');
      div.className = 'project-detail';
      div.innerHTML =
        '<div class="project-detail-info">' + hTag + '<b>' + escapeHtml(p.name) + '</b><br>' +
          '<span style="font-size:11px;">' + escapeHtml(kvInfo) + subInfo + envInfo + ' | 源: ' + escapeHtml(p.codeUrl || '默认') + '</span>' +
        '</div>' +
        '<div class="project-detail-actions">' +
          '<button class="btn-icon p-up" ' + uDis + ' data-type="' + type + '" data-idx="' + originalIdx + '">' + ICONS.up + '</button>' +
          '<button class="btn-icon p-dn" ' + dDis + ' data-type="' + type + '" data-idx="' + originalIdx + '">' + ICONS.down + '</button>' +
          '<button class="btn-icon p-edit" data-type="' + type + '" data-id="' + escapeHtml(p.id) + '" style="color:var(--primary)">' + ICONS.edit + '</button>' +
          '<button class="btn-icon p-del" data-type="' + type + '" data-id="' + escapeHtml(p.id) + '" style="color:#ef4444">' + ICONS.del + '</button>' +
        '</div>';
      return div;
    }

    // ==================== 渲染第二区 & 第三区：全局项目列表 ====================
    function renderGlobalProjects(type) {
      const list = type === 'worker' ? workerProjects : pageProjects;
      const container = document.getElementById(type === 'worker' ? 'globalWorkerList' : 'globalPageList');
      container.innerHTML = '';

      if (!list || list.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#94a3b8; font-size:13px; margin:10px 0;">暂无项目，请点击右上角新增。</p>';
        return;
      }

      const visibleItems = [];
      const hiddenItems = [];
      list.forEach((p, idx) => {
        if (p.show === false) hiddenItems.push({ p, idx });
        else visibleItems.push({ p, idx });
      });

      if (visibleItems.length === 0) {
        const emptyTip = document.createElement('p');
        emptyTip.style.cssText = 'text-align:center; color:#94a3b8; font-size:12px; margin:6px 0;';
        emptyTip.textContent = '暂无启用显示的项目';
        container.appendChild(emptyTip);
      } else {
        visibleItems.forEach(({ p, idx }) => {
          container.appendChild(buildProjectDetailElement(p, idx, list.length, type));
        });
      }

      if (hiddenItems.length > 0) {
        const stateKey = type === 'worker' ? 'hiddenWorker' : 'hiddenPage';
        const isExpanded = !!collapseState[stateKey];

        const wrap = document.createElement('div');
        wrap.className = 'hidden-proj-wrapper';

        const header = document.createElement('div');
        header.className = 'hidden-proj-header';
        header.innerHTML = '<span>🙈 隐藏的项目 (' + hiddenItems.length + ')</span><span class="h-arrow">' + (isExpanded ? '▲' : '▼') + '</span>';

        const body = document.createElement('div');
        body.className = 'hidden-proj-body' + (isExpanded ? ' active' : '');

        hiddenItems.forEach(({ p, idx }) => {
          body.appendChild(buildProjectDetailElement(p, idx, list.length, type));
        });

        header.addEventListener('click', () => {
          const next = !body.classList.contains('active');
          collapseState[stateKey] = next;
          body.classList.toggle('active', next);
          header.querySelector('.h-arrow').textContent = next ? '▲' : '▼';
        });

        wrap.appendChild(header);
        wrap.appendChild(body);
        container.appendChild(wrap);
      }

      container.querySelectorAll('.p-up').forEach(b => b.addEventListener('click', async () => {
        const arr = b.dataset.type === 'worker' ? workerProjects : pageProjects;
        if (moveArrItem(arr, parseInt(b.dataset.idx), -1)) { await saveGlobalProjectsToServer(); renderAll(); }
      }));
      container.querySelectorAll('.p-dn').forEach(b => b.addEventListener('click', async () => {
        const arr = b.dataset.type === 'worker' ? workerProjects : pageProjects;
        if (moveArrItem(arr, parseInt(b.dataset.idx), 1)) { await saveGlobalProjectsToServer(); renderAll(); }
      }));
      container.querySelectorAll('.p-edit').forEach(b => b.addEventListener('click', () => openProjModal(b.dataset.type, b.dataset.id)));
      container.querySelectorAll('.p-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('确认删除此全局项目配置？')) return;
        const id = b.dataset.id;
        if (b.dataset.type === 'worker') {
          workerProjects = workerProjects.filter(w => w.id !== id);
        } else {
          pageProjects = pageProjects.filter(p => p.id !== id);
        }
        await saveGlobalProjectsToServer();
        renderAll();
      }));
    }

    /* 缺省前缀下拉切换与设置弹窗逻辑 */
    document.getElementById('sysDefaultPrefixSelect').addEventListener('change', async function () {
      const selectedVal = ensureTrailingSlash(this.value);
      sysDefaultPrefix = selectedVal;
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultPrefix: selectedVal, prefixes: prefixList })
      });
      const data = await res.json();
      if (!data.success) alert('切换前缀失败');
    });

    function renderPrefixManageList() {
      const box = document.getElementById('prefixManageList');
      box.innerHTML = '';
      if (!draftPrefixes.length) {
        box.innerHTML = '<div style="text-align:center; color:#94a3b8; font-size:12px; padding:12px;">暂无前缀，请在上方输入后点击“添加”。</div>';
        return;
      }
      draftPrefixes.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'prefix-manage-row';
        const disUp = idx === 0 ? 'disabled' : '';
        const disDn = idx === draftPrefixes.length - 1 ? 'disabled' : '';
        row.innerHTML =
          '<input type="text" class="draft-prefix-input" data-idx="' + idx + '" value="' + escapeHtml(p) + '">' +
          '<button type="button" class="btn-icon pm-up" ' + disUp + ' data-idx="' + idx + '" title="上移">' + ICONS.up + '</button>' +
          '<button type="button" class="btn-icon pm-dn" ' + disDn + ' data-idx="' + idx + '" title="下移">' + ICONS.down + '</button>' +
          '<button type="button" class="btn-icon pm-del" data-idx="' + idx + '" style="color:#ef4444" title="删除">' + ICONS.del + '</button>';
        box.appendChild(row);
      });

      box.querySelectorAll('.draft-prefix-input').forEach(inp => {
        inp.addEventListener('change', function () {
          const i = parseInt(this.dataset.idx);
          const norm = ensureTrailingSlash(this.value);
          this.value = norm;
          draftPrefixes[i] = norm;
        });
      });
      box.querySelectorAll('.pm-up').forEach(btn => {
        btn.addEventListener('click', () => {
          syncDraftInputsFromDom();
          if (moveArrItem(draftPrefixes, parseInt(btn.dataset.idx), -1)) renderPrefixManageList();
        });
      });
      box.querySelectorAll('.pm-dn').forEach(btn => {
        btn.addEventListener('click', () => {
          syncDraftInputsFromDom();
          if (moveArrItem(draftPrefixes, parseInt(btn.dataset.idx), 1)) renderPrefixManageList();
        });
      });
      box.querySelectorAll('.pm-del').forEach(btn => {
        btn.addEventListener('click', () => {
          syncDraftInputsFromDom();
          draftPrefixes.splice(parseInt(btn.dataset.idx), 1);
          renderPrefixManageList();
        });
      });
    }

    function syncDraftInputsFromDom() {
      const inputs = document.querySelectorAll('#prefixManageList .draft-prefix-input');
      if (inputs.length === draftPrefixes.length) {
        draftPrefixes = Array.from(inputs).map(el => ensureTrailingSlash(el.value)).filter(Boolean);
      }
    }

    document.getElementById('btnOpenPrefixModal').addEventListener('click', function (e) {
      e.stopPropagation();
      draftPrefixes = [...prefixList];
      document.getElementById('newPrefixInput').value = '';
      renderPrefixManageList();
      document.getElementById('prefixModal').classList.add('active');
    });

    document.getElementById('btnAddPrefixItem').addEventListener('click', function () {
      syncDraftInputsFromDom();
      const raw = document.getElementById('newPrefixInput').value.trim();
      if (!raw) return alert('请输入前缀地址');
      const norm = ensureTrailingSlash(raw);
      if (!draftPrefixes.includes(norm)) {
        draftPrefixes.push(norm);
      }
      document.getElementById('newPrefixInput').value = '';
      renderPrefixManageList();
    });

    document.getElementById('newPrefixInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('btnAddPrefixItem').click();
      }
    });

    document.getElementById('btnCancelPrefixModal').addEventListener('click', () => {
      document.getElementById('prefixModal').classList.remove('active');
    });

    document.getElementById('btnSavePrefixModal').addEventListener('click', async function () {
      syncDraftInputsFromDom();
      const cleaned = draftPrefixes.map(ensureTrailingSlash).filter(Boolean);
      const nextDefault = cleaned.includes(sysDefaultPrefix) ? sysDefaultPrefix : (cleaned[0] || '');
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: cleaned, defaultPrefix: nextDefault })
      });
      const data = await res.json();
      if (data.success) {
        prefixList = data.prefixes || cleaned;
        sysDefaultPrefix = data.defaultPrefix ?? nextDefault;
        renderPrefixDropdown();
        document.getElementById('prefixModal').classList.remove('active');
      } else {
        alert('保存失败');
      }
    });

    /* 备份恢复逻辑 */
    document.getElementById('btnBackup').addEventListener('click', async () => {
      if (!confirm('备份当前所有配置到 KV？')) return;
      const data = await (await fetch('/api/accounts/backup', { method: 'POST' })).json();
      alert(data.success ? '✅ 成功！文件名: ' + data.key : '❌ 失败');
    });
    document.getElementById('btnExport').addEventListener('click', () => window.location.href = '/api/accounts/export');
    document.getElementById('btnShowRestore').addEventListener('click', async () => {
      const data = await (await fetch('/api/accounts/backup')).json();
      if (!data.success || !data.backups.length) return alert('未找到备份');
      const sel = document.getElementById('backupSelect'); sel.innerHTML = '';
      data.backups.sort().reverse().forEach(b => sel.appendChild(new Option(b, b)));
      document.getElementById('restoreModal').classList.add('active');
    });
    document.getElementById('btnConfirmRestore').addEventListener('click', async () => {
      const key = document.getElementById('backupSelect').value; if (!key || !confirm('将覆盖所有配置！确认？')) return;
      const data = await (await fetch('/api/accounts/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })).json();
      if (data.success) { alert('✅ 恢复成功'); document.getElementById('restoreModal').classList.remove('active'); loadAccounts(); }
    });
    document.getElementById('btnCancelRestore').addEventListener('click', () => document.getElementById('restoreModal').classList.remove('active'));
    document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', function (e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async e => {
        try {
          const json = JSON.parse(e.target.result);
          if (!confirm('将导入并覆盖配置！确认？')) return;
          const data = await (await fetch('/api/accounts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) })).json();
          if (data.success) { alert('✅ 导入成功'); loadAccounts(); } else alert('❌ 失败');
        } catch (err) { alert('⚠️ JSON 解析失败'); }
        document.getElementById('importFile').value = '';
      }; reader.readAsText(file);
    });

    /* 项目 KV 行构建函数（参考 ENV 行设计） */
    function buildProjKvRow(binding = '', name = '', action = 'keep') {
      const div = document.createElement('div');
      div.className = 'kv-row-item';
      div.style.cssText = 'display:flex; gap:6px; align-items:center;';
      div.innerHTML = \`
        <input type="text" class="k-bind" placeholder="KV变量(如KV)" value="\${escapeHtml(binding)}" style="flex:2; padding:6px; font-size:12px;">
        <input type="text" class="k-repo" placeholder="KV仓库名" value="\${escapeHtml(name)}" style="flex:3; padding:6px; font-size:12px;">
        <select class="k-act" style="flex:1; padding:6px; font-size:12px;">
          <option value="keep" \${action === 'keep' ? 'selected' : ''}>保留</option>
          <option value="clear" \${action === 'clear' ? 'selected' : ''}>清空</option>
        </select>
        <span class="r-kv" style="color:#ef4444; cursor:pointer; font-size:14px; padding:4px;" title="删除">✖</span>
      \`;
      div.querySelector('.r-kv').addEventListener('click', () => div.remove());
      document.getElementById('projKvList').appendChild(div);
    }
    document.getElementById('btnAddProjKv').addEventListener('click', (e) => {
      e.preventDefault();
      buildProjKvRow();
    });

    /* 通用 ENV 行构建函数 */
    function buildEnvRow(containerId, name = '', value = '', action = 'keep') {
      const div = document.createElement('div');
      div.className = 'env-row-item';
      div.style.cssText = 'display:flex; gap:6px; align-items:center;';
      div.innerHTML = \`
        <input type="text" class="e-name" placeholder="变量名" value="\${escapeHtml(name)}" style="flex:2; padding:6px; font-size:12px;">
        <input type="text" class="e-val" placeholder="变量值" value="\${escapeHtml(value)}" style="flex:3; padding:6px; font-size:12px;">
        <select class="e-act" style="flex:1; padding:6px; font-size:12px;">
          <option value="keep" \${action === 'keep' ? 'selected' : ''}>保留</option>
          <option value="replace" \${action === 'replace' ? 'selected' : ''}>替换</option>
        </select>
        <span class="r-env" style="color:#ef4444; cursor:pointer; font-size:14px; padding:4px;" title="删除">✖</span>
      \`;
      div.querySelector('.r-env').addEventListener('click', () => div.remove());
      document.getElementById(containerId).appendChild(div);
    }
    document.getElementById('btnAddAccEnv').addEventListener('click', (e) => { e.preventDefault(); buildEnvRow('accEnvList'); });
    document.getElementById('btnAddProjEnv').addEventListener('click', (e) => { e.preventDefault(); buildEnvRow('projEnvList'); });

    function renderSingleAttachBox(boxId, list, selectedIds, cbClass, emptyText) {
      const box = document.getElementById(boxId);
      box.innerHTML = '';
      if (!list || list.length === 0) {
        box.innerHTML = '<div style="color:#94a3b8; font-size:12px;">' + emptyText + '</div>';
        return;
      }

      const visibleList = list.filter(item => item.show !== false);
      const hiddenList = list.filter(item => item.show === false);

      if (visibleList.length > 0) {
        const grid = document.createElement('div');
        grid.className = 'attach-grid';
        grid.innerHTML = visibleList.map(item => {
          const checked = selectedIds.includes(item.id) ? 'checked' : '';
          return '<label class="attach-item"><input type="checkbox" class="' + cbClass + '" value="' + escapeHtml(item.id) + '" ' + checked + '> ' + escapeHtml(item.name) + '</label>';
        }).join('');
        box.appendChild(grid);
      } else {
        const tip = document.createElement('div');
        tip.style.cssText = 'color:#94a3b8; font-size:12px; margin-bottom:4px;';
        tip.textContent = '暂无启用显示的项目';
        box.appendChild(tip);
      }

      if (hiddenList.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'hidden-proj-wrapper';
        wrap.style.marginTop = visibleList.length > 0 ? '8px' : '0';

        const header = document.createElement('div');
        header.className = 'hidden-proj-header';
        header.innerHTML = '<span>🙈 隐藏的项目 (' + hiddenList.length + ')</span><span class="h-arrow">▼</span>';

        const body = document.createElement('div');
        body.className = 'hidden-proj-body';
        const hGrid = document.createElement('div');
        hGrid.className = 'attach-grid';
        hGrid.innerHTML = hiddenList.map(item => {
          const checked = selectedIds.includes(item.id) ? 'checked' : '';
          return '<label class="attach-item"><input type="checkbox" class="' + cbClass + '" value="' + escapeHtml(item.id) + '" ' + checked + '> <span style="color:#94a3b8;">' + escapeHtml(item.name) + '</span></label>';
        }).join('');
        body.appendChild(hGrid);

        header.addEventListener('click', () => {
          const next = !body.classList.contains('active');
          body.classList.toggle('active', next);
          header.querySelector('.h-arrow').textContent = next ? '▲' : '▼';
        });

        wrap.appendChild(header);
        wrap.appendChild(body);
        box.appendChild(wrap);
      }
    }

    function renderAttachGrids(selectedWorkers = [], selectedPages = []) {
      renderSingleAttachBox('attachWorkerBox', workerProjects, selectedWorkers, 'att-w-cb', '请先在第二区添加 Worker 项目');
      renderSingleAttachBox('attachPageBox', pageProjects, selectedPages, 'att-p-cb', '请先在第三区添加 Pages 项目');
    }

    /* 第一区：服务器组新增/编辑弹窗 */
    function openAddAccount() {
      editingIdentifier = null;
      document.getElementById('modalTitle').textContent = '添加服务器组';
      document.getElementById('editIdentifier').value = '';
      document.getElementById('editAccountId').value = '';
      document.getElementById('editToken').value = '';
      document.getElementById('editDomain').value = '';
      document.getElementById('editCfDomain').checked = false;
      document.getElementById('accEnvList').innerHTML = '';
      document.getElementById('editAccountShow').checked = true;
      renderAttachGrids([], []);
      document.getElementById('editModal').classList.add('active');
    }

    function openEditAccount(id) {
      const acc = accounts.find(a => a.identifier === id); if (!acc) return;
      editingIdentifier = id;
      document.getElementById('modalTitle').textContent = '编辑服务器组: ' + id;
      document.getElementById('editIdentifier').value = acc.identifier;
      document.getElementById('editAccountId').value = acc.accountId;
      document.getElementById('editToken').value = acc.token;
      document.getElementById('editDomain').value = acc.domain || '';
      document.getElementById('editCfDomain').checked = acc.cfDomain === true;

      document.getElementById('accEnvList').innerHTML = '';
      (acc.envs || []).forEach(e => buildEnvRow('accEnvList', e.name, e.value, e.action));

      document.getElementById('editAccountShow').checked = acc.show !== false;
      renderAttachGrids(acc.attachedWorkers || [], acc.attachedPages || []);
      document.getElementById('editModal').classList.add('active');
    }

    document.getElementById('btnAddAccount').addEventListener('click', (e) => {
      e.stopPropagation();
      openAddAccount();
    });
    document.getElementById('btnCancel').addEventListener('click', () => document.getElementById('editModal').classList.remove('active'));

    document.getElementById('btnSave').addEventListener('click', async () => {
      const identifier = document.getElementById('editIdentifier').value.trim();
      const accountId = document.getElementById('editAccountId').value.trim();
      const token = document.getElementById('editToken').value.trim();
      const domain = document.getElementById('editDomain').value.trim();
      const cfDomain = document.getElementById('editCfDomain').checked;
      if (!identifier || !accountId || !token) return alert('标识、Account ID 和 Token 不能为空');

      const getEnvs = (cid) => Array.from(document.querySelectorAll('#' + cid + ' .env-row-item')).map(el => ({
        name: el.querySelector('.e-name').value.trim(),
        value: el.querySelector('.e-val').value.trim(),
        action: el.querySelector('.e-act').value
      })).filter(i => i.name);

      const attachedWorkers = Array.from(document.querySelectorAll('.att-w-cb:checked')).map(cb => cb.value);
      const attachedPages = Array.from(document.querySelectorAll('.att-p-cb:checked')).map(cb => cb.value);

      const payload = {
        identifier, accountId, token, domain, cfDomain,
        show: document.getElementById('editAccountShow').checked,
        envs: getEnvs('accEnvList'),
        attachedWorkers,
        attachedPages
      };

      const data = await (await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
      if (data.success) {
        document.getElementById('editModal').classList.remove('active');
        setZoneExpanded('zone1Body', true);
        loadAccounts();
      } else alert('保存失败');
    });

    /* 第二区 & 第三区：全局项目新增/编辑弹窗 */
    function openProjModal(type, projId = null) {
      editingProjType = type;
      editingProjId = projId;
      const isWorker = type === 'worker';
      document.getElementById('projModalTitle').textContent = (projId ? '编辑 ' : '新增 ') + (isWorker ? 'Worker 项目' : 'Pages 项目');
      document.getElementById('pUrlLabel').textContent = isWorker ? '代码源地址 (JS URL 或相对路径)' : 'ZIP 文件地址 (ZIP URL 或相对路径)';
      document.getElementById('pSubdomainWrap').style.display = isWorker ? 'block' : 'none';
      document.getElementById('projKvList').innerHTML = '';
      document.getElementById('projEnvList').innerHTML = '';

      if (projId) {
        const list = isWorker ? workerProjects : pageProjects;
        const proj = list.find(p => p.id === projId);
        if (proj) {
          document.getElementById('pName').value = proj.name || '';
          const kvItems = getProjectKvList(proj);
          if (kvItems.length > 0) {
            kvItems.forEach(k => buildProjKvRow(k.binding, k.name, k.action));
          } else {
            buildProjKvRow();
          }
          document.getElementById('pCodeUrl').value = proj.codeUrl || '';
          document.getElementById('pSubdomain').value = proj.subdomain || '';
          document.getElementById('pShow').checked = proj.show !== false;
          (proj.envs || []).forEach(e => buildEnvRow('projEnvList', e.name, e.value, e.action));
        }
      } else {
        document.getElementById('pName').value = '';
        buildProjKvRow();
        document.getElementById('pCodeUrl').value = '';
        document.getElementById('pSubdomain').value = '';
        document.getElementById('pShow').checked = true;
      }
      document.getElementById('projModal').classList.add('active');
    }

    document.getElementById('btnAddGlobalWorker').addEventListener('click', (e) => {
      e.stopPropagation();
      openProjModal('worker', null);
    });
    document.getElementById('btnAddGlobalPage').addEventListener('click', (e) => {
      e.stopPropagation();
      openProjModal('page', null);
    });
    document.getElementById('btnCancelProj').addEventListener('click', () => document.getElementById('projModal').classList.remove('active'));

    document.getElementById('btnSaveProj').addEventListener('click', async () => {
      const name = document.getElementById('pName').value.trim();
      if (!name) return alert('项目名称不能为空');

      const kvs = Array.from(document.querySelectorAll('#projKvList .kv-row-item')).map(el => ({
        binding: el.querySelector('.k-bind').value.trim(),
        name: el.querySelector('.k-repo').value.trim(),
        action: el.querySelector('.k-act').value
      })).filter(i => i.name || i.binding);

      const firstKv = kvs[0] || { binding: '', name: '', action: 'keep' };

      const envs = Array.from(document.querySelectorAll('#projEnvList .env-row-item')).map(el => ({
        name: el.querySelector('.e-name').value.trim(),
        value: el.querySelector('.e-val').value.trim(),
        action: el.querySelector('.e-act').value
      })).filter(i => i.name);

      const isWorker = editingProjType === 'worker';
      const itemObj = {
        id: editingProjId || ((isWorker ? 'w_' : 'p_') + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        name,
        kvs,
        kvBinding: firstKv.binding,
        kvName: firstKv.name,
        kvAction: firstKv.action,
        codeUrl: document.getElementById('pCodeUrl').value.trim(),
        envs,
        show: document.getElementById('pShow').checked
      };
      if (isWorker) {
        itemObj.subdomain = document.getElementById('pSubdomain').value.trim();
      }

      const targetList = isWorker ? workerProjects : pageProjects;
      if (editingProjId) {
        const idx = targetList.findIndex(p => p.id === editingProjId);
        if (idx >= 0) targetList[idx] = itemObj;
      } else {
        targetList.push(itemObj);
      }

      const res = await saveGlobalProjectsToServer();
      if (res.success) {
        document.getElementById('projModal').classList.remove('active');
        setZoneExpanded(isWorker ? 'zone2Body' : 'zone3Body', true);
        renderAll();
      } else {
        alert('保存失败');
      }
    });

    loadAccounts();
  </script>
</body></html>`;
}

// ==================== 部署记录页面 ====================
function getRecordsPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>部署记录</title><style>${GLOBAL_STYLE}
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .filter-group { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
    .filter-group input, .filter-group select { width: auto; min-width: 130px; padding: 8px 12px; }
    .legend-bar { display: flex; gap: 16px; align-items: center; font-size: 12px; color: #64748b; margin-bottom: 12px; flex-wrap: wrap; }
    .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
    .table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 1240px; }
    th, td { padding: 10px 10px; border-bottom: 1px solid #f1f5f9; text-align: left; vertical-align: top; word-break: break-all; }
    th { background: #f8fafc; color: #334155; font-weight: 600; white-space: nowrap; }
    tr:hover td { background: #fafbfc; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500; white-space: nowrap; }
    .badge-ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .badge-err { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .badge-w { background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
    .badge-p { background: #eff6ff; color: #1d4ed8; border: 1px solid #dbeafe; }
    .item-line { line-height: 1.55; margin-bottom: 2px; }
    .item-line:last-child { margin-bottom: 0; }
    .cfg-new { color: #047857; font-weight: 600; }
    .cfg-old { color: #1d4ed8; font-weight: 500; }
    .log-btn { padding: 4px 8px; font-size: 11px; background: #f1f5f9; color: #334155; border-radius: 5px; white-space: nowrap; }
    .log-btn:hover { background: #e2e8f0; }
  </style></head><body>
  <div class="container" style="max-width: 1320px;">
    <div class="card">
      <h2>📜 部署记录</h2>

      <div class="toolbar">
        <div class="filter-group">
          <input type="text" id="filterKeyword" placeholder="搜索项目名/服务器/KV/ENV/域名...">
          <select id="filterStatus">
            <option value="">全部状态</option>
            <option value="成功">成功</option>
            <option value="失败">失败</option>
          </select>
          <select id="filterMethod">
            <option value="">全部方式</option>
            <option value="Worker">Worker</option>
            <option value="Pages">Pages</option>
          </select>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="btnExportXlsx" class="btn-primary" style="padding:8px 14px; font-size:12px; background:#10b981;">📊 导出 XLSX</button>
          <button id="btnExportJson" class="btn-primary" style="padding:8px 14px; font-size:12px; background:#8b5cf6;">📥 导出 JSON</button>
          <button id="btnRefreshRecords" class="btn-primary" style="padding:8px 14px; font-size:12px;">🔄 刷新</button>
          <button id="btnClearRecords" class="btn-danger" style="padding:8px 14px; font-size:12px;">🗑️ 清空记录</button>
        </div>
      </div>

      <div class="legend-bar">
        <span>KV / ENV 颜色说明：</span>
        <span><i class="legend-dot" style="background:#047857;"></i><span class="cfg-new">绿色字体：本次新设置 / 替换</span></span>
        <span><i class="legend-dot" style="background:#1d4ed8;"></i><span class="cfg-old">蓝色字体：项目原有绑定 / 保留</span></span>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>部署时间</th>
              <th>部署状态</th>
              <th>服务器</th>
              <th>部署方式</th>
              <th>项目名称</th>
              <th>KV变量</th>
              <th>KV仓库</th>
              <th>ENV变量</th>
              <th>ENV值</th>
              <th>子域名</th>
              <th>自定义域名</th>
              <th>CF域名</th>
              <th>项目来源</th>
              <th>耗时/来源</th>
              <th>日志</th>
            </tr>
          </thead>
          <tbody id="recordsTbody">
            <tr><td colspan="15" style="text-align:center; color:#94a3b8; padding:24px;">加载中...</td></tr>
          </tbody>
        </table>
      </div>

      <div class="nav-links">
        <a href="/dashboard">📋 常用部署</a>
        <a href="/accounts">⚙️ 账户设置</a>
        <a href="/">🏠 返回主页</a>
        <a href="/logout" class="danger-link">🚪 退出登录</a>
      </div>
    </div>
  </div>

  <div id="recordLogModal" class="modal">
    <div class="modal-content">
      <h3 id="recordLogTitle" style="margin-bottom:12px; font-size:16px;">部署日志详情</h3>
      <textarea id="recordLogText" readonly style="height:320px;"></textarea>
      <div style="margin-top:14px; text-align:right;">
        <button id="btnCloseRecordLog" class="btn-primary" style="padding:8px 18px;">关闭</button>
      </div>
    </div>
  </div>

  <script>
    let allRecords = [];
    let currentFilteredRecords = [];

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text == null ? '' : String(text);
      return div.innerHTML;
    }

    function normalizeKvItems(r) {
      if (Array.isArray(r.kvItems) && r.kvItems.length > 0) return r.kvItems;
      if (r.kvVar || r.kvRepo) {
        return [{ name: r.kvVar || '-', repo: r.kvRepo || '-', action: '', isNew: true }];
      }
      return [];
    }

    function normalizeEnvItems(r) {
      if (Array.isArray(r.envItems) && r.envItems.length > 0) return r.envItems;
      if (r.envVars || r.envValues) {
        const names = String(r.envVars || '').split(', ');
        const vals = String(r.envValues || '').split(', ');
        return names.filter(Boolean).map((n, idx) => ({
          name: n,
          value: vals[idx] !== undefined ? vals[idx] : '',
          isNew: true
        }));
      }
      return [];
    }

    function renderColoredKvCells(r) {
      const items = normalizeKvItems(r);
      if (!items.length) return { varHtml: '-', repoHtml: '-' };
      const varHtml = items.map(item => {
        const cls = item.isNew ? 'cfg-new' : 'cfg-old';
        return '<div class="item-line ' + cls + '">' + escapeHtml(item.name || '-') + '</div>';
      }).join('');
      const repoHtml = items.map(item => {
        const cls = item.isNew ? 'cfg-new' : 'cfg-old';
        const suffix = item.action ? ' (' + item.action + ')' : '';
        return '<div class="item-line ' + cls + '">' + escapeHtml((item.repo || '-') + suffix) + '</div>';
      }).join('');
      return { varHtml, repoHtml };
    }

    function renderColoredEnvCells(r) {
      const items = normalizeEnvItems(r);
      if (!items.length) return { nameHtml: '-', valHtml: '-' };
      const nameHtml = items.map(item => {
        const cls = item.isNew ? 'cfg-new' : 'cfg-old';
        return '<div class="item-line ' + cls + '">' + escapeHtml(item.name || '-') + '</div>';
      }).join('');
      const valHtml = items.map(item => {
        const cls = item.isNew ? 'cfg-new' : 'cfg-old';
        const valText = item.value === '' ? '(空)' : String(item.value ?? '');
        return '<div class="item-line ' + cls + '">' + escapeHtml(valText) + '</div>';
      }).join('');
      return { nameHtml, valHtml };
    }

    async function loadRecords() {
      const res = await fetch('/api/records');
      const data = await res.json();
      if (data.success) {
        allRecords = data.records || [];
        renderRecords();
      } else {
        document.getElementById('recordsTbody').innerHTML = '<tr><td colspan="15" style="text-align:center; color:#ef4444; padding:20px;">加载失败</td></tr>';
      }
    }

    function renderRecords() {
      const kw = document.getElementById('filterKeyword').value.trim().toLowerCase();
      const st = document.getElementById('filterStatus').value;
      const md = document.getElementById('filterMethod').value;

      currentFilteredRecords = allRecords.filter(r => {
        if (st && r.status !== st) return false;
        if (md && r.method !== md) return false;
        if (kw) {
          const kvText = normalizeKvItems(r).map(k => k.name + ' ' + k.repo).join(' ');
          const envText = normalizeEnvItems(r).map(e => e.name + ' ' + e.value).join(' ');
          const hay = [
            r.time, r.status, r.server, r.method, r.projectName,
            kvText, envText, r.subdomain,
            r.customDomains, r.cfDomain, r.sourceUrl, r.triggerSource
          ].join(' ').toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });

      const tbody = document.getElementById('recordsTbody');
      if (!currentFilteredRecords.length) {
        tbody.innerHTML = '<tr><td colspan="15" style="text-align:center; color:#94a3b8; padding:24px;">暂无部署记录</td></tr>';
        return;
      }

      tbody.innerHTML = currentFilteredRecords.map((r, idx) => {
        const statusBadge = r.status === '成功'
          ? '<span class="badge badge-ok">成功</span>'
          : '<span class="badge badge-err">' + escapeHtml(r.status || '失败') + '</span>';
        const methodBadge = r.method === 'Worker'
          ? '<span class="badge badge-w">Worker</span>'
          : '<span class="badge badge-p">Pages</span>';
        const metaExtra = [r.duration, r.triggerSource].filter(Boolean).join(' · ');
        const kvCells = renderColoredKvCells(r);
        const envCells = renderColoredEnvCells(r);

        return '<tr>' +
          '<td style="white-space:nowrap;">' + escapeHtml(r.time) + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + escapeHtml(r.server || '-') + '</td>' +
          '<td>' + methodBadge + '</td>' +
          '<td><b>' + escapeHtml(r.projectName || '-') + '</b></td>' +
          '<td>' + kvCells.varHtml + '</td>' +
          '<td>' + kvCells.repoHtml + '</td>' +
          '<td>' + envCells.nameHtml + '</td>' +
          '<td>' + envCells.valHtml + '</td>' +
          '<td>' + escapeHtml(r.subdomain || '-') + '</td>' +
          '<td>' + escapeHtml(r.customDomains || '-') + '</td>' +
          '<td>' + escapeHtml(r.cfDomain || '-') + '</td>' +
          '<td>' + escapeHtml(r.sourceUrl || '-') + '</td>' +
          '<td>' + escapeHtml(metaExtra || '-') + '</td>' +
          '<td><button type="button" class="log-btn view-log-btn" data-idx="' + idx + '">查看</button></td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('.view-log-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = currentFilteredRecords[parseInt(btn.dataset.idx)];
          document.getElementById('recordLogTitle').textContent = '部署日志：' + (item.projectName || '') + ' (' + (item.time || '') + ')';
          document.getElementById('recordLogText').value = (item.logs && item.logs.length) ? item.logs.join('\\n') : '无日志详情';
          document.getElementById('recordLogModal').classList.add('active');
        });
      });
    }

    // ==================== 纯前端构建标准 XLSX 文件并导出 ====================
    function xmlEscape(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, '');
    }

    function colIndexToLetters(idx) {
      let n = idx + 1;
      let s = '';
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    }

    function createZipStore(files) {
      const enc = new TextEncoder();
      const crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c;
      }
      function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
      }

      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const f of files) {
        const nameBytes = enc.encode(f.name);
        const dataBytes = enc.encode(f.content);
        const crc = crc32(dataBytes);

        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, 0, true);
        lv.setUint16(12, 0, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, dataBytes.length, true);
        lv.setUint32(22, dataBytes.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        localHeader.set(nameBytes, 30);

        localParts.push(localHeader, dataBytes);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, dataBytes.length, true);
        cv.setUint32(24, dataBytes.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        centralHeader.set(nameBytes, 46);

        centralParts.push(centralHeader);
        offset += localHeader.length + dataBytes.length;
      }

      const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);

      return new Blob([...localParts, ...centralParts, eocd], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
    }

    function exportRecordsToXlsx(records) {
      const headers = [
        '部署时间', '部署状态', '服务器', '部署方式', '项目名称',
        'KV变量', 'KV仓库', 'ENV变量', 'ENV值',
        '子域名', '自定义域名', 'CF域名', '项目来源', '耗时', '触发来源', '部署日志'
      ];

      const rows = [headers];
      records.forEach(r => {
        const kvList = normalizeKvItems(r);
        const envList = normalizeEnvItems(r);

        const kvVarsStr = kvList.map(k => (k.isNew ? '[新] ' : '[原] ') + (k.name || '')).join('\\n');
        const kvReposStr = kvList.map(k => (k.isNew ? '[新] ' : '[原] ') + (k.repo || '') + (k.action ? ' (' + k.action + ')' : '')).join('\\n');
        const envVarsStr = envList.map(e => (e.isNew ? '[新] ' : '[原] ') + (e.name || '')).join('\\n');
        const envValsStr = envList.map(e => (e.isNew ? '[新] ' : '[原] ') + (e.value ?? '')).join('\\n');

        rows.push([
          r.time || '',
          r.status || '',
          r.server || '',
          r.method || '',
          r.projectName || '',
          kvVarsStr,
          kvReposStr,
          envVarsStr,
          envValsStr,
          r.subdomain || '',
          r.customDomains || '',
          r.cfDomain || '',
          r.sourceUrl || '',
          r.duration || '',
          r.triggerSource || '',
          Array.isArray(r.logs) ? r.logs.join('\\n') : ''
        ]);
      });

      const sheetRowsXml = rows.map((row, rIdx) => {
        const rowNum = rIdx + 1;
        const cellsXml = row.map((val, cIdx) => {
          const ref = colIndexToLetters(cIdx) + rowNum;
          const styleAttr = rIdx === 0 ? ' s="1"' : ' s="2"';
          return '<c r="' + ref + '" t="inlineStr"' + styleAttr + '><is><t xml:space="preserve">' + xmlEscape(val) + '</t></is></c>';
        }).join('');
        return '<row r="' + rowNum + '">' + cellsXml + '</row>';
      }).join('');

      const colWidths = [20, 10, 24, 10, 18, 18, 24, 18, 24, 14, 28, 30, 36, 10, 12, 48];
      const colsXml = '<cols>' + colWidths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';

      const worksheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        colsXml +
        '<sheetData>' + sheetRowsXml + '</sheetData>' +
        '</worksheet>';

      const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2">' +
          '<font><sz val="10"/><name val="Arial"/></font>' +
          '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>' +
        '</fonts>' +
        '<fills count="3">' +
          '<fill><patternFill patternType="none"/></fill>' +
          '<fill><patternFill patternType="gray125"/></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>' +
        '</fills>' +
        '<borders count="2">' +
          '<border><left/><right/><top/><bottom/><diagonal/></border>' +
          '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>' +
        '</borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3">' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
          '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
        '</cellXfs>' +
        '</styleSheet>';

      const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="部署记录" sheetId="1" r:id="rId1"/></sheets>' +
        '</workbook>';

      const workbookRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>';

      const rootRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>';

      const contentTypesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>';

      const blob = createZipStore([
        { name: '[Content_Types].xml', content: contentTypesXml },
        { name: '_rels/.rels', content: rootRelsXml },
        { name: 'xl/workbook.xml', content: workbookXml },
        { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
        { name: 'xl/styles.xml', content: stylesXml },
        { name: 'xl/worksheets/sheet1.xml', content: worksheetXml }
      ]);

      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      triggerDownload(blob, 'deploy_records_' + ts + '.xlsx');
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    document.getElementById('btnExportXlsx').addEventListener('click', () => {
      if (!currentFilteredRecords.length) return alert('当前没有可导出的部署记录');
      exportRecordsToXlsx(currentFilteredRecords);
    });

    document.getElementById('btnExportJson').addEventListener('click', () => {
      if (!currentFilteredRecords.length) return alert('当前没有可导出的部署记录');
      const blob = new Blob([JSON.stringify(currentFilteredRecords, null, 2)], { type: 'application/json;charset=utf-8' });
      const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      triggerDownload(blob, 'deploy_records_' + ts + '.json');
    });

    document.getElementById('filterKeyword').addEventListener('input', renderRecords);
    document.getElementById('filterStatus').addEventListener('change', renderRecords);
    document.getElementById('filterMethod').addEventListener('change', renderRecords);
    document.getElementById('btnRefreshRecords').addEventListener('click', loadRecords);
    document.getElementById('btnCloseRecordLog').addEventListener('click', () => {
      document.getElementById('recordLogModal').classList.remove('active');
    });
    document.getElementById('btnClearRecords').addEventListener('click', async () => {
      if (!confirm('确认清空全部部署记录？')) return;
      const res = await fetch('/api/records', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) loadRecords();
      else alert('清空失败');
    });

    loadRecords();
  </script>
</body></html>`;
}

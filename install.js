const CURRENT_VERSION = "1.1.202611261738"; // 当前版本号，置于顶部方便随时修改

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
      } catch(e) {
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

    return new Response(getMainPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },
};

// ==================== 常量 ====================
const DEFAULT_WORKER_CODE_URL = "https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js";
const DEFAULT_PAGES_ZIP_URL = "https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip";
const ACCOUNTS_KEY = "accounts";

// ==================== 工具函数 ====================
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
    log(`[提示] 未找到同名 KV，新建...`);
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

// 绑定 Worker 自定义域名（Custom Domains）
async function bindWorkerCustomDomain(accountId, headers, workerName, hostname, log) {
  const cleanHost = hostname.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!cleanHost || !cleanHost.includes('.')) {
    log(`[警告] 自定义域名格式无效 (${hostname})，跳过绑定`);
    return;
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
      return;
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
    } else {
      log(`[警告] 自定义域绑定失败: ${JSON.stringify(domData.errors)}`);
    }
  } catch (err) {
    log(`[警告] 自定义域绑定异常: ${err.message}`);
  }
}

// ==================== KV 账户与全局项目存储管理 ====================
async function getStoredData(env) {
  try {
    const raw = await env.KV.get(ACCOUNTS_KEY);
    if (!raw) return { accounts: [], workerProjects: [], pageProjects: [], defaultPrefix: "" };
    const parsed = JSON.parse(raw);
    let accounts = parsed.accounts || [];
    let workerProjects = Array.isArray(parsed.workerProjects) ? parsed.workerProjects : [];
    let pageProjects = Array.isArray(parsed.pageProjects) ? parsed.pageProjects : [];

    // 兼容旧版数据结构：如果全局项目表尚未建立，而旧账户内嵌了 workers/pages，自动提取迁移
    const hasLegacy = accounts.some(a => (a.workers && a.workers.length > 0) || (a.pages && a.pages.length > 0));
    if (workerProjects.length === 0 && pageProjects.length === 0 && hasLegacy) {
      const wMap = new Map();
      const pMap = new Map();
      accounts.forEach(acc => {
        if (!Array.isArray(acc.attachedWorkers)) acc.attachedWorkers = [];
        if (!Array.isArray(acc.attachedPages)) acc.attachedPages = [];
        (acc.workers || []).forEach((w, idx) => {
          const key = `${w.name}|${w.kvBinding||''}|${w.kvName||''}|${w.codeUrl||''}`;
          let id = wMap.get(key);
          if (!id) {
            id = `w_mig_${Date.now()}_${wMap.size}_${idx}`;
            wMap.set(key, id);
            workerProjects.push({
              id,
              name: w.name,
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
          const key = `${p.name}|${p.kvBinding||''}|${p.kvName||''}|${p.codeUrl||''}`;
          let id = pMap.get(key);
          if (!id) {
            id = `p_mig_${Date.now()}_${pMap.size}_${idx}`;
            pMap.set(key, id);
            pageProjects.push({
              id,
              name: p.name,
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

    return {
      accounts,
      workerProjects,
      pageProjects,
      defaultPrefix: parsed.defaultPrefix || ""
    };
  } catch {
    return { accounts: [], workerProjects: [], pageProjects: [], defaultPrefix: "" };
  }
}

async function getAccountsList(env) {
  const data = await getStoredData(env);
  return data.accounts;
}

// ==================== Worker 部署核心 ====================
async function deployWorkerCore(accountId, apiToken, kvName, workerName, codeUrl, kvAction = 'keep', envs = [], kvBinding = '', customDomain = '') {
  const logs = [];
  const log = (msg) => logs.push(msg);
  try {
    if (!codeUrl || codeUrl.trim() === "" || codeUrl.trim() === "default") codeUrl = DEFAULT_WORKER_CODE_URL;
    if (!accountId || !apiToken || !workerName) {
      return { success: false, error: "缺少必填参数", logs: ["ERR: 缺少必填参数"], status: 400 };
    }

    const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
    log(`[1/4] 拉取代码: ${codeUrl}`);
    const res = await fetchWithTimeout(codeUrl, {}, 15000);
    if (!res.ok) throw new Error(`拉取代码失败: HTTP ${res.status}`);
    const workerCode = await res.text();
    log(`[成功] 代码大小: ${workerCode.length} 字节`);

    const isESM = workerCode.includes("export default");
    let bindings = [];

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

    if (kvName && kvName.trim()) {
      const targetKvName = kvName.trim();
      let bindName = (kvBinding && kvBinding.trim()) ? kvBinding.trim() : "";
      if (!bindName) {
        const existingKvBinding = bindings.find(b => b.type === 'kv_namespace');
        bindName = existingKvBinding ? existingKvBinding.name : "KV";
      }

      log(`[提示] 正在配置 KV 命名空间 [${targetKvName}] (绑定变量名: ${bindName})...`);
      const kvId = await resolveKvNamespaceId(accountId, headers, targetKvName, kvAction, log);

      const newKvBindingObj = { type: "kv_namespace", name: bindName, namespace_id: kvId };
      const existBindIdx = bindings.findIndex(b => b.name === bindName);
      if (existBindIdx >= 0) {
        bindings[existBindIdx] = newKvBindingObj;
      } else {
        bindings.push(newKvBindingObj);
      }
      log(`[成功] KV 绑定配置完成 (变量名: ${bindName}, ID: ${kvId})`);
    } else {
      log(`[提示] 未指定新 KV，保留原有 KV 绑定关系`);
    }

    log(`[3/4] 处理附加环境变量 (ENV)...`);
    if (envs && envs.length > 0) {
      envs.forEach(env => {
        if (!env.name) return;
        const existingIdx = bindings.findIndex(b => b.name === env.name);
        if (existingIdx >= 0) {
          if (env.action === 'replace') {
            bindings[existingIdx] = { type: "plain_text", name: env.name, text: env.value };
            log(`  - [更新] 替换已有变量: ${env.name}`);
          } else {
            log(`  - [跳过] 保留已有变量: ${env.name}`);
          }
        } else {
          bindings.push({ type: "plain_text", name: env.name, text: env.value });
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

    if (customDomain && customDomain.trim()) {
      await bindWorkerCustomDomain(accountId, headers, workerName, customDomain.trim(), log);
    }

    return { success: true, logs, status: 200 };
  } catch (err) {
    log(`[错误] ${err.message}`);
    return { success: false, error: err.message, logs, status: 500 };
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

// ==================== Pages 配置更新函数 ====================
async function updatePagesConfig(accountId, apiToken, projectName, kvName, logs, log, kvAction = 'keep', envs = [], kvBinding = '') {
  const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
  try {
    log(`  - 拉取当前 Pages 项目配置...`);
    const projRes = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, { headers }, 15000);
    if (!projRes.ok) throw new Error(`获取 Pages 项目信息失败`);
    const projData = await projRes.json();
    
    let productionConfig = projData.result?.deployment_configs?.production || {};
    let previewConfig = projData.result?.deployment_configs?.preview || {};

    let kvNamespacesProd = productionConfig.kv_namespaces || {};
    let kvNamespacesPrev = previewConfig.kv_namespaces || {};
    
    let envVarsProd = productionConfig.env_vars || {};
    let envVarsPrev = previewConfig.env_vars || {};

    if (kvName) {
      let bindName = (kvBinding && kvBinding.trim()) ? kvBinding.trim() : "";
      if (!bindName) {
        const existingKeys = Object.keys(kvNamespacesProd);
        bindName = existingKeys.length > 0 ? existingKeys[0] : "KV";
      }

      const kvId = await resolveKvNamespaceId(accountId, headers, kvName.trim(), kvAction, (msg) => log(`  - ${msg}`));
      
      kvNamespacesProd[bindName] = { namespace_id: kvId }; 
      kvNamespacesPrev[bindName] = { namespace_id: kvId }; 
      log(`  - KV 绑定就绪 (变量名: ${bindName}, ID: ${kvId})`);
    }

    if (envs && envs.length > 0) {
      envs.forEach(env => {
        if (!env.name) return;
        if (envVarsProd[env.name] && env.action === 'keep') {
          log(`  - [跳过] 保留原有变量: ${env.name}`);
        } else {
          envVarsProd[env.name] = { type: "plain_text", value: env.value };
          envVarsPrev[env.name] = { type: "plain_text", value: env.value };
          log(`  - [更新/新增] 环境变量: ${env.name}`);
        }
      });
    }

    const updatePayload = {
      deployment_configs: {
        production: {},
        preview: {}
      }
    };

    if (kvName) {
      updatePayload.deployment_configs.production.kv_namespaces = kvNamespacesProd;
      updatePayload.deployment_configs.preview.kv_namespaces = kvNamespacesPrev;
    }

    if (envs && envs.length > 0) {
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
  } catch (err) {
    log(`  - [错误] 更新配置失败: ${err.message}`);
    throw err;
  }
}

// ==================== Pages 部署核心 ====================
async function deployPagesCore(accountId, apiToken, kvName, projectName, zipUrl, kvAction = 'keep', envs = [], kvBinding = '') {
  const logs = [];
  const log = (msg) => logs.push(msg);
  try {
    if (!zipUrl || zipUrl.trim() === "" || zipUrl.trim() === "default") zipUrl = DEFAULT_PAGES_ZIP_URL;
    if (!accountId || !apiToken || !projectName) {
      return { success: false, error: "缺少参数", logs: ["ERR: 缺少参数"], status: 400 };
    }

    const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
    log(`[1/6] 下载 ZIP: ${zipUrl}`);
    const zipRes = await fetchWithTimeout(zipUrl, {}, 30000);
    if (!zipRes.ok) throw new Error(`下载失败`);
    const zipBuf = await zipRes.arrayBuffer();

    log(`[2/6] 解压...`);
    const files = await extractZip(zipBuf);

    log(`[3/6] 检查项目...`);
    let actualDomain = `${projectName}.pages.dev`;
    let targetBranch = "main";
    const check = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, { headers }, 30000);
    
    if (check.status === 404) {
      const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, { method: "POST", headers, body: JSON.stringify({ name: projectName, production_branch: "main" }) }, 30000)).json();
      if (!create.success) throw new Error(`创建失败: ${JSON.stringify(create.errors)}`);
      if (create.result && create.result.subdomain) actualDomain = create.result.subdomain;
    } else if (check.ok) {
      const projInfo = await check.json();
      if (projInfo.result) {
        if (projInfo.result.subdomain) actualDomain = projInfo.result.subdomain;
        if (projInfo.result.production_branch) targetBranch = projInfo.result.production_branch;
      }
    } else {
      const errText = await check.text();
      throw new Error(`检查项目状态异常 (${check.status}): ${errText}`);
    }

    if ((kvName && kvName.trim()) || (envs && envs.length > 0)) {
      log(`[4/6] 更新项目配置(KV/ENV)...`);
      await updatePagesConfig(accountId, apiToken, projectName, kvName ? kvName.trim() : "", logs, log, kvAction, envs, kvBinding);
    } else {
      log(`[4/6] 无新KV及ENV配置，保留原有绑定设置...`);
    }

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
    log(`[访问] 域名: https://${actualDomain}`); 
    return { success: true, logs, deploymentId: deployData.result.id, projectName, status: 200 };
    
  } catch (err) {
    log(`[错误] ${err.message}`);
    return { success: false, error: err.message, logs, status: 500 };
  }
}

// ==================== 缺省前缀辅助函数 ====================
async function getSystemPrefix(env) {
  try {
    const raw = await env.KV.get(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw).defaultPrefix || "") : "";
  } catch { return ""; }
}

function processSourceUrl(url, prefix) {
  if (!url || url.trim() === "" || url.trim() === "default") return url;
  if (url.toLowerCase().startsWith('http://') || url.toLowerCase().startsWith('https://')) return url;
  return prefix ? (prefix + url.trim()) : url.trim();
}

// ==================== 统一部署分发 ====================
async function deployByType(type, id, token, kv, name, source, kvAction = 'keep', envs = [], kvBinding = '', customDomain = '') {
  const t = String(type || "").toLowerCase();
  const src = source || "default";
  if (!t || !id || !token || !name) return { success: false, error: "参数缺失", logs: ["ERR"], status: 400 };
  if (t === "worker") return deployWorkerCore(id, token, kv || "", name, src, kvAction, envs, kvBinding, customDomain);
  if (t === "page" || t === "pages") return deployPagesCore(id, token, kv || "", name, src, kvAction, envs, kvBinding);
  return { success: false, error: "type 无效", logs: ["ERR"], status: 400 };
}

async function handleUnifiedDeploy(request, env) {
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
      name: b.name || b.projectname, 
      source: b.source || b.codeurl || b.zipurl || b.url, 
      envs: b.envs || [],
      customDomain: b.customDomain || b.customdomain || b.domain || ''
    };
  } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    p = { 
      type: fd.get("type"), 
      id: fd.get("id") || fd.get("accountid"), 
      token: fd.get("token"), 
      kvBinding: fd.get("kvBinding") || fd.get("kvbinding") || fd.get("kvVar") || fd.get("kvvar") || '',
      kv: fd.get("kv") || fd.get("kvname"), 
      kvAction: fd.get("kvAction") || fd.get("kvaction") || 'keep', 
      name: fd.get("name") || fd.get("projectname"), 
      source: fd.get("source") || fd.get("codeurl") || fd.get("zipurl") || fd.get("url"), 
      envs: [],
      customDomain: fd.get("customDomain") || fd.get("customdomain") || fd.get("domain") || ''
    }; 
  }
  const prefix = await getSystemPrefix(env);
  p.source = processSourceUrl(p.source, prefix);
  const result = await deployByType(p.type, p.id, p.token, p.kv, p.name, p.source, p.kvAction, p.envs, p.kvBinding, p.customDomain);
  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleGetDeploy(url, env) {
  const q = url.searchParams;
  const prefix = await getSystemPrefix(env);
  const source = processSourceUrl(q.get("codeurl") || q.get("source") || q.get("zipurl") || "default", prefix);
  const kvBinding = q.get("kvBinding") || q.get("kvbinding") || q.get("kvVar") || q.get("kvvar") || "";
  const customDomain = q.get("customDomain") || q.get("customdomain") || q.get("domain") || "";
  const result = await deployByType(q.get("type"), q.get("accountid") || q.get("id"), q.get("token"), q.get("kvname") || q.get("kv"), q.get("projectname") || q.get("name"), source, q.get("kvAction") || 'keep', [], kvBinding, customDomain);
  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleDeployWorker(request, env) {
  const b = await request.json().catch(() => ({}));
  const prefix = await getSystemPrefix(env);
  const codeUrl = processSourceUrl(b.codeUrl, prefix);
  const r = await deployWorkerCore(b.accountId, b.apiToken, b.kvName, b.workerName, codeUrl, b.kvAction || 'keep', b.envs || [], b.kvBinding || '', b.customDomain || '');
  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json" } });
}

async function handleDeployPages(request, env) {
  const b = await request.json().catch(() => ({}));
  const prefix = await getSystemPrefix(env);
  const zipUrl = processSourceUrl(b.zipUrl, prefix);
  const r = await deployPagesCore(b.accountId, b.apiToken, b.kvName, b.projectName, zipUrl, b.kvAction || 'keep', b.envs || [], b.kvBinding || '');
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
    data.defaultPrefix = body.defaultPrefix || "";
    await env.KV.put(ACCOUNTS_KEY, JSON.stringify(data));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch(e) { 
    return new Response(JSON.stringify({ success: false }), { status: 500 }); 
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
  } catch(e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handlePostAccount(request, env) {
  try {
    const body = await request.json();
    if (!body?.identifier) return new Response(JSON.stringify({ success: false, error: "标识必填" }), { status: 400 });
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
    const key = `backup_${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
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
  .container { width: 100%; max-width: 950px; }
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
    
    pre { background: #f8fafc; color: #334155; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin-bottom: 10px; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; }
    .info-section { margin-bottom: 20px; }
    .info-section h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; color: #1e293b; }
    .info-section p { font-size: 13px; color: #475569; margin-bottom: 8px; line-height: 1.6; }
  </style></head><body>
  <div class="container" style="max-width: 600px;">
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
      
      <div class="form-group" style="display: flex; gap: 10px; align-items: flex-end;">
        <div style="width: 140px;"><label>KV 变量名（可选）</label><input type="text" id="kvBinding" placeholder="留空保留原有关系"></div>
        <div style="flex: 1;"><label>KV 名称（命名空间，可选）</label><input type="text" id="kvName" placeholder="留空保留原绑定"></div>
        <div style="width: 90px;"><select id="kvAction" disabled><option value="keep">保留</option><option value="clear">清空</option></select></div>
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

      <div style="margin-top: 20px;"><label style="font-size:13px; font-weight:500;">部署日志</label><textarea id="logOutput" readonly placeholder="日志输出..."></textarea></div>

      <div class="accordion" style="margin-top: 15px;">
        <div class="accordion-header" data-target="infoPanel"><span>📖 使用说明</span><span class="arrow">▼</span></div>
        <div id="infoPanel" class="accordion-content">
          <div class="info-section">
            <h3>📋 常用部署与三区配置说明</h3>
            <p>点击底部 <strong>📋 常用部署</strong> -> <strong>⚙️ 账户设置</strong>，配置已拆分为三个独立折叠区域，实现项目一次配置、多服务器组复用：</p>
            <pre><code>1. 第一区【服务器设置（账户组）】：
   - 配置组标识、Account ID、API Token、默认组环境变量(ENV)以及【组项目域名】（例如：example.com）。
   - 直接勾选附加第二区和第三区已录入的 Worker / Pages 项目；未附加的项目不会出现在常用部署清单中。

2. 第二区【Worker 项目区】：
   - 全局维护 Worker 项目模板，支持为单个项目独立配置专属环境变量(ENV)（可选“保留”或“替换”策略）及【自定义子域名】（例如：sub）。
   - 自动域名拼接规则：当 Worker 项目配置了子域名（如 sub）且所属服务器组配置了项目域名（如 example.com）时，部署完成后自动为该 Worker 绑定自定义域 sub.example.com（需确保该域名已托管在对应 Cloudflare 账户下）。

3. 第三区【Pages 项目区】：
   - 全局维护 Pages 项目模板，同样支持为单个项目独立配置专属环境变量(ENV)（可选“保留”或“替换”策略）。
   - 设为隐藏的项目会自动归类收纳至“隐藏的项目”折叠标签中，点击可展开管理。

※ 环境变量优先级说明：常用部署时，若在组内勾选了“附加组 ENV”，系统会将组变量与项目独立变量合并；遇到同名变量时，优先使用项目自身的独立 ENV 配置。</code></pre>
          </div>
          <div class="info-section">
            <h3>🌐 单次页面部署</h3>
            <p>在当前表单中填写 Account ID、API Token、KV 变量名（可选，留空保留原有关系）、KV 名称（命名空间，可选）和项目名称，然后选择对应的部署面板（Worker 或 Pages），填写代码源地址（Worker 可选填完整自定义域）并点击部署按钮。</p>
            <p><strong>Worker 示例：</strong></p>
            <pre><code>Account ID: 8ab2...c8d0
API Token: cfcut_...
KV 变量名: KV （可留空，留空则保留原有绑定关系；新绑定且未填时默认使用 KV）
KV 名称: MY_KV_STORE （命名空间名称，可留空）保留：使用原KV内容，清空：清空原KV内容
变量设置： 变量名自定义，区分大小写 变量值填内容 保留原值：遇同名变量时使用原值，使用新值：遇同名变量时替换为新值
项目名称: my-worker-app
代码源地址: https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js
自定义域: app.example.com （可选，留空不绑定）</code></pre>
            <p><strong>Pages 示例：</strong></p>
            <pre><code>Account ID: 8ab2...c8d0
API Token: cfcut_...
KV 变量名: KV （可留空，留空则保留原有绑定关系；新绑定且未填时默认使用 KV）
KV 名称: MY_KV_STORE （命名空间名称，可留空）保留：使用原KV内容，清空：清空原KV内容
变量设置： 变量名自定义，区分大小写 变量值填内容 保留原值：遇同名变量时使用原值，使用新值：遇同名变量时替换为新值
项目名称: my-pages-site
ZIP 地址: https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip</code></pre>
          </div>
          <div class="info-section">
            <h3>⚡ POST 部署</h3>
            <p>向 <code>/api/deploy</code> 发送 POST 请求，支持 JSON 或传统表单格式（可通过 <code>kvBinding</code> 指定 KV 变量名，通过 <code>customDomain</code> 指定 Worker 自定义域名）。</p>
            <p style="color: #e74c3c; font-weight: 500; font-size: 12px; margin: 5px 0 10px;">※ 安全提示：如果您在环境变量配置了 PASSWORD 密码，API 请求必须携带密码（通过 URL 参数 ?pwd=密码 或 Header头 Authorization: Bearer 密码）。</p>
            <p><strong>JavaScript (Fetch) 格式（推荐使用 Header 鉴权）：</strong></p>
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
    kvBinding: "",
    kv: "MY_KV_STORE",
    kvAction: "keep",
    name: "my-worker-app",
    source: "default",
    customDomain: "app.example.com"
  })
}).then(res => res.json()).then(console.log);</code></pre>
            <p><strong>cURL JSON 格式（使用 URL 传参鉴权）：</strong></p>
            <pre><code>curl -X POST "https://your-worker.workers.dev/api/deploy?pwd=您的系统访问密码" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "worker",
    "id": "YOUR_ACCOUNT_ID",
    "token": "YOUR_API_TOKEN",
    "kvBinding": "",
    "kv": "MY_KV_STORE",
    "kvAction": "keep",
    "source": "default",
    "name": "my-worker-app",
    "customDomain": "app.example.com"
  }'</code></pre>
            <p><strong>cURL 表单格式（使用 Header 鉴权）：</strong></p>
            <pre><code>curl -X POST "https://your-worker.workers.dev/api/deploy" \\
  -H "Authorization: Bearer 您的系统访问密码" \\
  -H "Content-Type": "application/x-www-form-urlencoded" \\
  -d "type=worker&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvBinding=&kvname=MY_KV_STORE&kvAction=keep&projectname=my-worker-app&codeurl=default&customDomain=app.example.com"</code></pre>
            <p>Pages 部署只需将 <code>type</code> 改为 <code>page</code>，源地址参数可用 <code>zipurl</code> 或 <code>source</code>。</p>
          </div>
          <div class="info-section">
            <h3>🔗 GET 部署</h3>
            <p>直接在浏览器地址栏或脚本中通过 URL 调用（可通过 <code>kvBinding</code> 参数指定 KV 变量名，通过 <code>customDomain</code> 指定 Worker 自定义域名）。</p>
            <p style="color: #e74c3c; font-weight: 500; font-size: 12px; margin: 5px 0 10px;">※ 安全提示：若开启了密码保护，必须在 URL 任意位置追加 &pwd=您的系统访问密码</p>
            <pre><code>https://your-worker.workers.dev/api/deploy?type=worker&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvBinding=&kvname=&projectname=my-worker-app&codeurl=default&customDomain=app.example.com&pwd=您的系统访问密码</code></pre>
            <p>Pages 部署示例：</p>
            <pre><code>https://your-worker.workers.dev/api/deploy?type=page&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvBinding=&kvname=&projectname=my-pages-site&zipurl=https://example.com/site.zip&pwd=您的系统访问密码</code></pre>
          </div>
        </div>
      </div>

      <div class="nav-links" style="align-items: center;">
        <a href="/dashboard">📋 常用部署</a>
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
    (function(){
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
          kvBinding: '',
          kvName: '',
          kvAction: 'keep',
          workerName: 'install',
          codeUrl: 'https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/install.js'
        };

        try {
          const res = await fetch('/api/deploy-worker', {
            method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
          });
          const data = await res.json();
          output.value += (data.logs || []).join('\\n') + '\\n';
          if (data.success) output.value += '\\n✅ 系统自动更新成功！请稍候刷新页面即可生效。';
        } catch (err) {
          output.value += '[错误] ' + err.message + '\\n';
        }
        output.scrollTop = output.scrollHeight;
      });

      const kvInput = document.getElementById('kvName'), kvAction = document.getElementById('kvAction');
      kvInput.addEventListener('input', () => kvAction.disabled = !kvInput.value.trim());

      const envContainer = document.getElementById('envContainer');
      document.getElementById('enableEnv').addEventListener('change', function() {
        envContainer.style.display = this.checked ? 'block' : 'none';
        if(this.checked && document.getElementById('envList').children.length === 0) addEnvRow();
      });
      document.getElementById('btnAddEnv').addEventListener('click', () => addEnvRow());

      function addEnvRow() {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:6px; margin-bottom:8px; align-items:center;';
        div.innerHTML = \`
          <input type="text" class="env-name" placeholder="变量名(大写)" style="flex:2;">
          <input type="text" class="env-value" placeholder="变量值" style="flex:3;">
          <select class="env-action" style="flex:1; padding:10px 4px;"><option value="keep">保留原值</option><option value="replace">使用新值</option></select>
          <button class="btn-icon r-env-btn" style="color:#ef4444" title="删除">✖</button>
        \`;
        div.querySelector('.r-env-btn').addEventListener('click', () => div.remove());
        document.getElementById('envList').appendChild(div);
      }

      document.querySelectorAll('.accordion-header').forEach(h => h.addEventListener('click', function(){
        const target = document.getElementById(this.dataset.target);
        const isActive = target.classList.contains('active');
        document.querySelectorAll('.accordion-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.accordion-header .arrow').forEach(a => a.textContent = '▼');
        if (!isActive) { target.classList.add('active'); this.querySelector('.arrow').textContent = '▼'; }
      }));

      async function runDeploy(type) {
        const accountId = document.getElementById('accountId').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const kvBinding = document.getElementById('kvBinding').value.trim();
        const kvName = document.getElementById('kvName').value.trim();
        const kvActionVal = document.getElementById('kvAction').value;
        const name = document.getElementById('projectName').value.trim();
        const src = document.getElementById(type === 'worker' ? 'workerCodeUrl' : 'pagesZipUrl').value.trim();
        const customDomain = type === 'worker' ? document.getElementById('workerCustomDomain').value.trim() : '';
        if (!accountId || !apiToken || !name) return alert('请填写必填项');
        
        let envs = [];
        if (document.getElementById('enableEnv').checked) {
          document.querySelectorAll('#envList > div').forEach(row => {
            const envName = row.querySelector('.env-name').value.trim();
            const envValue = row.querySelector('.env-value').value.trim();
            const envAction = row.querySelector('.env-action').value;
            if (envName) envs.push({ name: envName, value: envValue, action: envAction });
          });
        }

        const output = document.getElementById('logOutput');
        output.value = '部署中...\\n'; output.scrollTop = output.scrollHeight;
        
        const payload = type === 'worker' 
          ? {accountId, apiToken, kvBinding, kvName, kvAction: kvActionVal, workerName: name, codeUrl: src, envs, customDomain}
          : {accountId, apiToken, kvBinding, kvName, kvAction: kvActionVal, projectName: name, zipUrl: src, envs};
          
        const res = await fetch(type === 'worker' ? '/api/deploy-worker' : '/api/deploy-pages', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
        });
        const data = await res.json();
        output.value = (data.logs || []).join('\\n'); output.scrollTop = output.scrollHeight;
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
      <div style="margin-top: 15px;"><textarea id="logOutput" readonly placeholder="日志将在此输出..."></textarea></div>
      <div class="nav-links">
        <a href="/accounts">⚙️ 账户设置</a>
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
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text||''; return div.innerHTML; }
    
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
        
        const accDiv = document.createElement('div');
        accDiv.className = 'account-item';
        accDiv.innerHTML = 
          '<div class="account-header" data-acc-index="' + accIndex + '">' +
            '<div style="display:flex; align-items:center;"><input type="checkbox" class="account-checkbox" data-acc-index="' + accIndex + '"><span class="account-name">' + escapeHtml(account.identifier) + '</span>' + domainBadge + '</div>' +
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
              '<input type="text" class="temp-kv-binding" data-acc-index="' + accIndex + '" placeholder="KV变量名(可选)">' +
              '<input type="text" class="temp-kv" data-acc-index="' + accIndex + '" placeholder="KV名(可选)">' +
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

      document.querySelectorAll('.account-header').forEach(h => h.addEventListener('click', function(e) {
        if (e.target.tagName === 'INPUT') return; 
        const list = this.nextElementSibling;
        list.classList.toggle('active');
        this.querySelector('.arrow').textContent = list.classList.contains('active') ? '▲' : '▼';
      }));
      document.querySelectorAll('.project-title').forEach(t => t.addEventListener('click', function(e) {
        if (e.target.tagName === 'INPUT') return;
        this.nextElementSibling.classList.toggle('active');
      }));

      function addDashboardEnvRow(listNode, name = '', val = '', action = 'keep') {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:6px; align-items:center;';
        div.innerHTML = '<input type="text" class="e-name" placeholder="变量名(如API_KEY)" value="' + escapeHtml(name) + '" style="flex:2; font-size:12px; padding:6px;">' +
                        '<input type="text" class="e-val" placeholder="变量值" value="' + escapeHtml(val) + '" style="flex:3; font-size:12px; padding:6px;">' +
                        '<select class="e-act" style="flex:1; font-size:12px; padding:6px;">' +
                          '<option value="keep" ' + (action==='keep'?'selected':'') + '>同名保留原值</option>' +
                          '<option value="replace" ' + (action==='replace'?'selected':'') + '>同名使用新值</option>' +
                        '</select>' +
                        '<span class="r-env" style="color:#ef4444; cursor:pointer; font-size:14px; padding:4px;" title="删除">✖</span>';
        div.querySelector('.r-env').addEventListener('click', () => div.remove());
        listNode.appendChild(div);
      }

      document.querySelectorAll('.temp-env-cb').forEach(cb => cb.addEventListener('change', function() {
        const idx = parseInt(this.dataset.accIndex);
        const list = document.querySelector('.temp-env-list[data-acc-index="'+idx+'"]');
        const btn = document.querySelector('.add-env-btn[data-acc-index="'+idx+'"]');
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

      document.querySelectorAll('.add-env-btn').forEach(btn => btn.addEventListener('click', function(e) {
        e.preventDefault();
        const list = document.querySelector('.temp-env-list[data-acc-index="' + this.dataset.accIndex + '"]');
        addDashboardEnvRow(list);
      }));

      document.querySelectorAll('.temp-kv').forEach(input => input.addEventListener('input', function() {
        const sel = document.querySelector('.temp-kv-action[data-acc-index="' + this.dataset.accIndex + '"]');
        if (sel) sel.disabled = !this.value.trim();
      }));
      document.querySelectorAll('.account-checkbox').forEach(cb => cb.addEventListener('change', function() {
        const idx = this.dataset.accIndex;
        document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"], .group-checkbox[data-acc-index="' + idx + '"]').forEach(c => c.checked = this.checked);
      }));
      document.querySelectorAll('.column-header').forEach(header => header.addEventListener('click', function(e) {
        const cb = this.querySelector('.group-checkbox');
        if (e.target.tagName !== 'INPUT') cb.checked = !cb.checked;
        document.querySelectorAll('.normal-checkbox[data-acc-index="' + this.dataset.accIndex + '"][data-type="' + this.dataset.group + '"]').forEach(c => c.checked = cb.checked);
        checkAccountSync(this.dataset.accIndex);
      }));
      document.querySelectorAll('.normal-checkbox').forEach(cb => cb.addEventListener('change', function() {
        checkGroupSync(this.dataset.accIndex, this.dataset.type);
        checkAccountSync(this.dataset.accIndex);
      }));

      function checkGroupSync(idx, type) {
        const all = document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"][data-type="' + type + '"]');
        const checked = document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"][data-type="' + type + '"]:checked');
        const gcb = document.querySelector('.group-checkbox[data-acc-index="' + idx + '"][data-group="' + type + '"]');
        if(gcb) gcb.checked = (all.length > 0 && all.length === checked.length);
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
        const bName = proj.kvBinding ? proj.kvBinding : '(原变量)';
        const kvDisp = proj.kvName ? (bName + ' -> ' + proj.kvName + ' (' + (proj.kvAction === 'clear' ? '清空' : '保留') + ')') : '(留空/保留原有关系)';
        
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

    document.getElementById('btnDeploySelected').addEventListener('click', async function() {
      const btn = this, output = document.getElementById('logOutput'), selected = [];
      document.querySelectorAll('.normal-checkbox:checked, .temp-checkbox:checked').forEach(cb => {
        const accIndex = parseInt(cb.dataset.accIndex), account = allAccounts[accIndex];
        if (cb.classList.contains('temp-checkbox')) {
          const type = document.querySelector('.temp-type[data-acc-index="' + accIndex + '"]').value;
          const name = document.querySelector('.temp-name[data-acc-index="' + accIndex + '"]').value.trim();
          const kvBinding = document.querySelector('.temp-kv-binding[data-acc-index="' + accIndex + '"]').value.trim();
          const kvName = document.querySelector('.temp-kv[data-acc-index="' + accIndex + '"]').value.trim();
          const kvAction = document.querySelector('.temp-kv-action[data-acc-index="' + accIndex + '"]').value;
          const codeUrl = document.querySelector('.temp-source[data-acc-index="' + accIndex + '"]').value.trim();
          if (name) selected.push({ type, account, proj: { name, kvBinding, kvName, kvAction, codeUrl: codeUrl || 'default', envs: [] } });
        } else {
          const type = cb.dataset.type, projId = cb.dataset.projId;
          const proj = type === 'worker' ? allWorkerProjects.find(w => w.id === projId) : allPageProjects.find(p => p.id === projId);
          if (proj) selected.push({ type, account, proj });
        }
      });
      if (selected.length === 0) return alert('请先勾选需要部署的项目');
      
      btn.disabled = true; output.value = '开始批量部署...\\n';
      
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        output.value += '\\n[' + (i+1) + '/' + selected.length + '] ' + item.account.identifier + ' <- ' + item.proj.name + '\\n';
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

          let customDomain = '';
          if (item.type === 'worker' && item.proj.subdomain && item.proj.subdomain.trim() && item.account.domain && item.account.domain.trim()) {
            customDomain = item.proj.subdomain.trim() + '.' + item.account.domain.trim();
          }

          const payload = { 
            type: item.type, id: item.account.accountId, token: item.account.token, 
            kvBinding: item.proj.kvBinding || '',
            kv: item.proj.kvName || '', kvAction: item.proj.kvAction || 'keep', 
            name: item.proj.name, source: item.proj.codeUrl || 'default',
            envs: finalEnvs,
            customDomain: customDomain
          };
          const res = await fetch('/api/deploy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          const data = await res.json();
          output.value += (data.logs || []).join('\\n') + '\\n';
        } catch (e) { output.value += '[错误] ' + e.message + '\\n'; }
        output.scrollTop = output.scrollHeight;
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
    
    /* 三区折叠卡片样式 */
    .zone-card { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; background: #fff; overflow: hidden; }
    .zone-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: #fafbfc; cursor: pointer; user-select: none; transition: 0.2s; }
    .zone-header:hover { background: #f1f2f6; }
    .zone-title { font-size: 15px; font-weight: 600; color: #1e293b; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .zone-badge { font-size: 11px; background: #fff7ed; color: var(--primary); border: 1px solid #fed7aa; padding: 2px 8px; border-radius: 99px; font-weight: 500; }
    .zone-header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .zone-arrow { color: #94a3b8; font-size: 12px; width: 16px; text-align: center; }
    .zone-body { display: none; padding: 16px 18px; border-top: 1px solid var(--border); background: #fff; }
    .zone-body.active { display: block; }

    /* 隐藏的项目折叠标签样式 */
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

    .attach-box { background: #f8fafc; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; max-height: 210px; overflow-y: auto; }
    .attach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
    .attach-item { display: flex; align-items: center; font-size: 13px; color: #334155; cursor: pointer; padding: 4px 6px; border-radius: 4px; background: #fff; border: 1px solid #eaedf1; }
    .attach-item:hover { border-color: var(--primary); }

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
          <div class="zone-title">🖥️ 第一区：服务器设置 <span class="zone-badge" id="zone1Count">0 组</span></div>
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
          <div class="zone-title">🚀 第二区：Worker 项目区 <span class="zone-badge" id="zone2Count">0 项</span></div>
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
          <div class="zone-title">📄 第三区：Pages 项目区 <span class="zone-badge" id="zone3Count">0 项</span></div>
          <div class="zone-header-right">
            <button id="btnAddGlobalPage" class="btn-primary" style="padding: 6px 12px; font-size: 12px;">➕ 新增 Pages 项目</button>
            <span class="zone-arrow">▼</span>
          </div>
        </div>
        <div id="zone3Body" class="zone-body">
          <div id="globalPageList"></div>
        </div>
      </div>
      
      <!-- 缺省地址前缀模块 -->
      <div class="zone-card" style="margin-bottom: 0; padding: 16px 18px;">
        <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #1e293b;">🔗 缺省地址前缀</h3>
        <div style="display:flex; align-items:center; gap:10px;">
           <input type="text" id="sysDefaultPrefix" readonly placeholder="例如: https://raw.githubusercontent.com/用户名/库名/main/" style="background:#f1f5f9; flex:1;">
           <button id="btnEditPrefix" class="btn-icon" style="color:var(--primary); flex-shrink:0;">${ICONS.edit}</button>
           <button id="btnSavePrefix" class="btn-primary" style="display:none; padding:8px 16px; flex-shrink:0;">保存</button>
        </div>
        <p style="font-size:12px; color:#94a3b8; margin-top:8px; line-height: 1.5;">部署时，若填写的源地址未以 http/https 开头，将自动在前面拼接此前缀。<br>提示：为了防止误改导致所有部署失败，请点击编辑图标进行修改，并注意确保末尾包含 / 等正确的拼接符。</p>
      </div>

      <div class="nav-links">
        <a href="/dashboard">📋 常用部署</a>
        <a href="/">🏠 返回主页</a>
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

  <!-- 第二区 & 第三区：全局 Worker / Pages 项目配置弹窗 -->
  <div id="projModal" class="modal">
    <div class="modal-content" style="max-width: 600px;">
      <h3 id="projModalTitle" style="margin-bottom:15px; font-size:16px;">配置项目</h3>
      <div class="form-group"><label>项目名称（Worker 脚本名 / Pages 项目名）</label><input type="text" id="pName" placeholder="例如：my-app"></div>
      <div class="form-group" style="display:flex; gap:10px; align-items:flex-end;">
        <div style="width:140px;"><label>KV 变量名（可选）</label><input type="text" id="pKvBinding" placeholder="留空保留原有关系"></div>
        <div style="flex:1;"><label>KV 名称（命名空间，可选）</label><input type="text" id="pKvName" placeholder="留空保留原绑定"></div>
        <div style="width:90px;"><select id="pKvAction" disabled><option value="keep">保留</option><option value="clear">清空</option></select></div>
      </div>
      <div class="form-group"><label id="pUrlLabel">代码源 / ZIP 地址</label><input type="text" id="pCodeUrl" placeholder="留空使用默认源，或填写相对路径/完整URL"></div>
      
      <div class="form-group" id="pSubdomainWrap">
        <label>自定义子域名（可选，仅 Worker 生效）</label>
        <input type="text" id="pSubdomain" placeholder="例如：api（部署时自动拼接为 api.该组项目域名）">
      </div>

      <div class="form-group" style="border: 1px dashed #cbd5e1; padding: 10px; border-radius: 8px; background:#fafbfc;">
        <label style="color:#334155; margin-bottom:5px;">项目独立环境变量 (ENV) <span style="font-size:11px;color:#94a3b8;font-weight:normal;">同名变量优先覆盖组 ENV</span></label>
        <div id="projEnvList" style="display:flex; flex-direction:column; gap:6px;"></div>
        <button id="btnAddProjEnv" class="add-btn" style="width:auto; margin-top:8px;">➕ 添加项目变量</button>
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
    let editingIdentifier = null;
    let editingProjType = 'worker';
    let editingProjId = null;

    // 记录三区以及“隐藏的项目”标签当前的展开状态（默认全部收起）
    const collapseState = {
      zone1Body: false,
      zone2Body: false,
      zone3Body: false,
      hiddenWorker: false,
      hiddenPage: false
    };

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

    // 绑定三区标题栏点击展开/收起事件
    document.querySelectorAll('.zone-header').forEach(header => {
      header.addEventListener('click', function(e) {
        if (e.target.closest('button')) return;
        const zoneId = this.dataset.zone;
        setZoneExpanded(zoneId, !collapseState[zoneId]);
      });
    });

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) { 
        accounts = data.accounts || []; 
        workerProjects = data.workerProjects || [];
        pageProjects = data.pageProjects || [];
        sysDefaultPrefix = data.defaultPrefix || "";
        const prefInput = document.getElementById('sysDefaultPrefix');
        if(prefInput) prefInput.value = sysDefaultPrefix;
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

    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text||''; return div.innerHTML; }
    function moveArrItem(arr, idx, dir) { const t = idx+dir; if(t<0||t>=arr.length) return false; [arr[idx], arr[t]] = [arr[t], arr[idx]]; return true; }

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
        const disUp = accIdx===0?'disabled':'', disDn = accIdx===accounts.length-1?'disabled':'';
        
        const attachedW = (acc.attachedWorkers || []).map(id => workerProjects.find(w => w.id === id)).filter(Boolean);
        const attachedP = (acc.attachedPages || []).map(id => pageProjects.find(p => p.id === id)).filter(Boolean);

        let htmlStr = '<div class="account-header">' +
          '<div class="account-header-left"><h3>' + escapeHtml(acc.identifier) + '</h3>' + hideTag + domainTag + '</div>' +
          '<div class="account-header-right">' +
            '<button class="btn-icon move-acc-up" ' + disUp + ' data-idx="' + accIdx + '">' + ICONS.up + '</button>' +
            '<button class="btn-icon move-acc-down" ' + disDn + ' data-idx="' + accIdx + '">' + ICONS.down + '</button>' +
            '<button class="btn-icon edit-btn" data-id="' + escapeHtml(acc.identifier) + '" style="color:var(--primary)">' + ICONS.edit + '</button>' +
            '<button class="btn-icon delete-btn" data-id="' + escapeHtml(acc.identifier) + '" style="color:#ef4444">' + ICONS.del + '</button>' +
            '<span class="arrow" style="color:#94a3b8; font-size:12px; margin-left:8px;">▼</span>' +
          '</div></div><div class="project-list">';
        
        let summaryHtml = '<div style="font-size:12px; color:#64748b; margin-bottom:6px;"><b>Account ID:</b> ' + escapeHtml(acc.accountId) + ' | <b>组域名:</b> ' + escapeHtml(acc.domain || '未设置') + '</div>';
        summaryHtml += '<div style="margin-bottom:6px;"><span style="font-size:12px; color:#475569; font-weight:500;">已附加 Workers (' + attachedW.length + ')：</span>' + 
          (attachedW.length ? attachedW.map(w => '<span class="tag-pill worker">' + escapeHtml(w.name) + (w.subdomain && acc.domain ? ' (' + escapeHtml(w.subdomain + '.' + acc.domain) + ')' : '') + '</span>').join('') : '<span style="font-size:12px;color:#94a3b8;">无</span>') + '</div>';
        summaryHtml += '<div><span style="font-size:12px; color:#475569; font-weight:500;">已附加 Pages (' + attachedP.length + ')：</span>' + 
          (attachedP.length ? attachedP.map(p => '<span class="tag-pill page">' + escapeHtml(p.name) + '</span>').join('') : '<span style="font-size:12px;color:#94a3b8;">无</span>') + '</div>';
        
        htmlStr += summaryHtml + '</div>';
        div.innerHTML = htmlStr;
        container.appendChild(div);
      });

      document.querySelectorAll('#accountList .account-header').forEach(h => h.addEventListener('click', function(e){
        if (e.target.closest('button')) return;
        const list = this.nextElementSibling;
        list.classList.toggle('active');
        const arrow = this.querySelector('.arrow');
        if (arrow) arrow.textContent = list.classList.contains('active') ? '▲' : '▼';
      }));
      document.querySelectorAll('.move-acc-up').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if(moveArrItem(accounts, parseInt(b.dataset.idx), -1)) saveAccountsOrder(); }));
      document.querySelectorAll('.move-acc-down').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if(moveArrItem(accounts, parseInt(b.dataset.idx), 1)) saveAccountsOrder(); }));
      document.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openEditAccount(b.dataset.id); }));
      document.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation(); if (confirm('删除服务器组 ' + b.dataset.id + '？')) { await fetch('/api/accounts?identifier=' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }); loadAccounts(); }
      }));
    }

    // 构建单条项目 DOM 卡片
    function buildProjectDetailElement(p, originalIdx, totalLen, type) {
      const hTag = p.show === false ? '<span style="color:#ef4444">[隐藏]</span> ' : '';
      const bName = p.kvBinding ? p.kvBinding : '(原变量)';
      const kvInfo = p.kvName ? ('KV: ' + bName + ' -> ' + p.kvName + (p.kvAction === 'clear' ? '(清)' : '')) : '保留原KV关系';
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

    // ==================== 渲染第二区 & 第三区：全局项目列表（含“隐藏的项目”独立折叠） ====================
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

      // 若存在隐藏的项目，渲染可点击展开/收起的“隐藏的项目”折叠栏
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

    /* 前缀修改保存逻辑 */
    document.getElementById('btnEditPrefix').addEventListener('click', function() {
       const input = document.getElementById('sysDefaultPrefix');
       input.readOnly = false;
       input.style.background = '#fff';
       input.focus();
       this.style.display = 'none';
       document.getElementById('btnSavePrefix').style.display = 'inline-flex';
    });

    document.getElementById('btnSavePrefix').addEventListener('click', async function() {
       const val = document.getElementById('sysDefaultPrefix').value.trim();
       const res = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ defaultPrefix: val }) });
       const data = await res.json();
       if(data.success) {
          const input = document.getElementById('sysDefaultPrefix');
          input.readOnly = true;
          input.style.background = '#f1f5f9';
          this.style.display = 'none';
          document.getElementById('btnEditPrefix').style.display = 'inline-flex';
       } else alert('保存失败');
    });

    /* 备份恢复逻辑 */
    document.getElementById('btnBackup').addEventListener('click', async () => {
      if(!confirm('备份当前所有配置到 KV？')) return;
      const data = await (await fetch('/api/accounts/backup', { method: 'POST' })).json();
      alert(data.success ? '✅ 成功！文件名: ' + data.key : '❌ 失败');
    });
    document.getElementById('btnExport').addEventListener('click', () => window.location.href = '/api/accounts/export');
    document.getElementById('btnShowRestore').addEventListener('click', async () => {
      const data = await (await fetch('/api/accounts/backup')).json();
      if(!data.success || !data.backups.length) return alert('未找到备份');
      const sel = document.getElementById('backupSelect'); sel.innerHTML = '';
      data.backups.sort().reverse().forEach(b => sel.appendChild(new Option(b, b)));
      document.getElementById('restoreModal').classList.add('active');
    });
    document.getElementById('btnConfirmRestore').addEventListener('click', async () => {
      const key = document.getElementById('backupSelect').value; if(!key || !confirm('将覆盖所有配置！确认？')) return;
      const data = await (await fetch('/api/accounts/restore', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key }) })).json();
      if(data.success) { alert('✅ 恢复成功'); document.getElementById('restoreModal').classList.remove('active'); loadAccounts(); }
    });
    document.getElementById('btnCancelRestore').addEventListener('click', () => document.getElementById('restoreModal').classList.remove('active'));
    document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', function(e) {
      const file = e.target.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = async e => {
        try {
          const json = JSON.parse(e.target.result);
          if(!confirm('将导入并覆盖配置！确认？')) return;
          const data = await (await fetch('/api/accounts/import', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(json) })).json();
          if(data.success) { alert('✅ 导入成功'); loadAccounts(); } else alert('❌ 失败');
        } catch(err) { alert('⚠️ JSON 解析失败'); }
        document.getElementById('importFile').value = '';
      }; reader.readAsText(file);
    });

    /* 通用 ENV 行构建函数 */
    function buildEnvRow(containerId, name='', value='', action='keep') {
      const div = document.createElement('div');
      div.className = 'env-row-item';
      div.style.cssText = 'display:flex; gap:6px; align-items:center;';
      div.innerHTML = \`
        <input type="text" class="e-name" placeholder="变量名" value="\${escapeHtml(name)}" style="flex:2; padding:6px; font-size:12px;">
        <input type="text" class="e-val" placeholder="变量值" value="\${escapeHtml(value)}" style="flex:3; padding:6px; font-size:12px;">
        <select class="e-act" style="flex:1; padding:6px; font-size:12px;">
          <option value="keep" \${action==='keep'?'selected':''}>保留</option>
          <option value="replace" \${action==='replace'?'selected':''}>替换</option>
        </select>
        <span class="r-env" style="color:#ef4444; cursor:pointer; font-size:14px; padding:4px;" title="删除">✖</span>
      \`;
      div.querySelector('.r-env').addEventListener('click', () => div.remove());
      document.getElementById(containerId).appendChild(div);
    }
    document.getElementById('btnAddAccEnv').addEventListener('click', (e) => { e.preventDefault(); buildEnvRow('accEnvList'); });
    document.getElementById('btnAddProjEnv').addEventListener('click', (e) => { e.preventDefault(); buildEnvRow('projEnvList'); });

    /* 渲染服务器组编辑弹窗内的项目勾选框（同样将隐藏项目归入折叠区） */
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
      
      document.getElementById('accEnvList').innerHTML = ''; 
      (acc.envs||[]).forEach(e => buildEnvRow('accEnvList', e.name, e.value, e.action));
      
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
      if (!identifier || !accountId || !token) return alert('标识、Account ID 和 Token 不能为空');
      
      const getEnvs = (cid) => Array.from(document.querySelectorAll('#' + cid + ' .env-row-item')).map(el => ({
        name: el.querySelector('.e-name').value.trim(),
        value: el.querySelector('.e-val').value.trim(),
        action: el.querySelector('.e-act').value
      })).filter(i => i.name);

      const attachedWorkers = Array.from(document.querySelectorAll('.att-w-cb:checked')).map(cb => cb.value);
      const attachedPages = Array.from(document.querySelectorAll('.att-p-cb:checked')).map(cb => cb.value);
      
      const payload = { 
        identifier, accountId, token, domain,
        show: document.getElementById('editAccountShow').checked, 
        envs: getEnvs('accEnvList'),
        attachedWorkers,
        attachedPages
      };
      
      const data = await (await fetch('/api/accounts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })).json();
      if (data.success) {
        document.getElementById('editModal').classList.remove('active');
        setZoneExpanded('zone1Body', true);
        loadAccounts();
      } else alert('保存失败');
    });

    /* 第二区 & 第三区：全局项目新增/编辑弹窗 */
    document.getElementById('pKvName').addEventListener('input', function() {
      document.getElementById('pKvAction').disabled = !this.value.trim();
    });

    function openProjModal(type, projId = null) {
      editingProjType = type;
      editingProjId = projId;
      const isWorker = type === 'worker';
      document.getElementById('projModalTitle').textContent = (projId ? '编辑 ' : '新增 ') + (isWorker ? 'Worker 项目' : 'Pages 项目');
      document.getElementById('pUrlLabel').textContent = isWorker ? '代码源地址 (JS URL 或相对路径)' : 'ZIP 文件地址 (ZIP URL 或相对路径)';
      document.getElementById('pSubdomainWrap').style.display = isWorker ? 'block' : 'none';
      document.getElementById('projEnvList').innerHTML = '';

      if (projId) {
        const list = isWorker ? workerProjects : pageProjects;
        const proj = list.find(p => p.id === projId);
        if (proj) {
          document.getElementById('pName').value = proj.name || '';
          document.getElementById('pKvBinding').value = proj.kvBinding || '';
          document.getElementById('pKvName').value = proj.kvName || '';
          document.getElementById('pKvAction').value = proj.kvAction || 'keep';
          document.getElementById('pKvAction').disabled = !(proj.kvName && proj.kvName.trim());
          document.getElementById('pCodeUrl').value = proj.codeUrl || '';
          document.getElementById('pSubdomain').value = proj.subdomain || '';
          document.getElementById('pShow').checked = proj.show !== false;
          (proj.envs || []).forEach(e => buildEnvRow('projEnvList', e.name, e.value, e.action));
        }
      } else {
        document.getElementById('pName').value = '';
        document.getElementById('pKvBinding').value = '';
        document.getElementById('pKvName').value = '';
        document.getElementById('pKvAction').value = 'keep';
        document.getElementById('pKvAction').disabled = true;
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

      const envs = Array.from(document.querySelectorAll('#projEnvList .env-row-item')).map(el => ({
        name: el.querySelector('.e-name').value.trim(),
        value: el.querySelector('.e-val').value.trim(),
        action: el.querySelector('.e-act').value
      })).filter(i => i.name);

      const isWorker = editingProjType === 'worker';
      const itemObj = {
        id: editingProjId || ((isWorker ? 'w_' : 'p_') + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        name,
        kvBinding: document.getElementById('pKvBinding').value.trim(),
        kvName: document.getElementById('pKvName').value.trim(),
        kvAction: document.getElementById('pKvAction').value,
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

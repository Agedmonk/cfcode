const CURRENT_VERSION = "1.0.202608181527"; // 当前版本号，置于顶部方便随时修改

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
	// ==================== 登录鉴权拦截 ====================
    const expectedPassword = env.AUTH_PASSWORD || 'NicholasLai' || 'TanMin19860621!' || 'LaiXiaoRu20110615!'; // 从 CF 环境变量读取密码或使用自定义密码
    if (expectedPassword) {
      // 支持三种鉴权：浏览器 Cookie、API Header、API URL 参数
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
              "Set-Cookie": `cf_auth=${expectedPassword}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax` // 登录态保持 30 天
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
            "Set-Cookie": `cf_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax` // 清除 Cookie
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
      if (request.method === "POST") return handleUnifiedDeploy(request);
      if (request.method === "GET") return handleGetDeploy(url);
    }
    if (path === "/api/deploy-worker" && request.method === "POST") return handleDeployWorker(request);
    if (path === "/api/deploy-pages" && request.method === "POST") return handleDeployPages(request);
    // === 账户 API ===
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
	// === 新数据备份、恢复、导出、导入 API ===
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

// ==================== KV 账户管理 ====================
async function getAccountsList(env) {
  try {
    const raw = await env.KV.get(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw).accounts || []) : [];
  } catch {
    return [];
  }
}

async function saveAccountsList(env, accounts) {
  await env.KV.put(ACCOUNTS_KEY, JSON.stringify({ accounts }));
}

async function findAccountIndex(env, identifier) {
  const accounts = await getAccountsList(env);
  return { accounts, idx: accounts.findIndex(a => a.identifier === identifier) };
}

// ==================== Worker 部署核心 ====================
async function deployWorkerCore(accountId, apiToken, kvName, workerName, codeUrl, kvAction = 'keep') {
  const logs = [];
  const log = (msg) => logs.push(msg);
  try {
    if (!codeUrl || codeUrl.trim() === "" || codeUrl.trim() === "default") codeUrl = DEFAULT_WORKER_CODE_URL;
    if (!accountId || !apiToken || !workerName) {
      return { success: false, error: "缺少必填参数", logs: ["ERR: 缺少必填参数"], status: 400 };
    }

    const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
    log(`[1/5] 拉取代码: ${codeUrl}`);
    const res = await fetchWithTimeout(codeUrl, {}, 15000);
    if (!res.ok) throw new Error(`拉取代码失败: HTTP ${res.status}`);
    const workerCode = await res.text();
    log(`[成功] 代码大小: ${workerCode.length} 字节`);

    const isESM = workerCode.includes("export default");
    let bindings = [];

    if (kvName && kvName.trim()) {
      log(`[2/5] 处理 KV [${kvName}]...`);
      const kvList = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { headers }, 15000)).json();
      if (!kvList.success) throw new Error(`查询 KV 失败: ${JSON.stringify(kvList.errors)}`);
      const existing = kvList.result.find(i => i.title === kvName);
      
      let kvId;
      if (existing) {
        if (kvAction === 'keep') {
          log(`[提示] 找到已存在同名 KV，执行保留策略...`);
          kvId = existing.id;
        } else {
          log(`[提示] 找到已存在同名 KV，执行清空策略 (先删后建)...`);
          const del = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${existing.id}`, { method: "DELETE", headers }, 15000)).json();
          if (!del.success) throw new Error(`删除旧 KV 失败: ${JSON.stringify(del.errors)}`);
          const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", headers, body: JSON.stringify({ title: kvName }) }, 15000)).json();
          if (!create.success) throw new Error(`创建 KV 失败: ${JSON.stringify(create.errors)}`);
          kvId = create.result.id;
        }
      } else {
        log(`[提示] 未找到同名 KV，新建...`);
        const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", headers, body: JSON.stringify({ title: kvName }) }, 15000)).json();
        if (!create.success) throw new Error(`创建 KV 失败: ${JSON.stringify(create.errors)}`);
        kvId = create.result.id;
      }
      bindings = [{ type: "kv_namespace", name: "KV", namespace_id: kvId }];
      log(`[成功] KV 绑定配置完成 (ID: ${kvId})`);
    } else {
      log(`[2/5] 保留原有绑定...`);
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
            log(`[成功] 获取并保留原有绑定 (${bindings.length}个)`);
          } else {
            log(`[提示] 原项目没有绑定配置`);
          }
        } else if (get.status === 404) {
          log(`[提示] 属于全新项目，无需保留旧绑定`);
        } else {
          log(`[警告] 获取旧绑定 API 异常: HTTP ${get.status}`);
        }
      } catch (err) {
        log(`[警告] 解析旧绑定出错: ${err.message}`);
      }
    }

    const metadata = { bindings };
    if (isESM) metadata.main_module = "_worker.js"; else metadata.body_part = "script";
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    const blob = new Blob([workerCode], { type: isESM ? "application/javascript+module" : "application/javascript" });
    if (isESM) form.append("_worker.js", blob, "_worker.js"); else form.append("script", blob);

    log(`[3/5] 部署 Worker [${workerName}]...`);
    const dep = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, { method: "PUT", headers: { "Authorization": `Bearer ${apiToken}` }, body: form }, 20000)).json();
    if (!dep.success) throw new Error(`部署失败: ${JSON.stringify(dep.errors)}`);
    log(`[成功] 部署完成`);
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

// ==================== Pages 部署核心 ====================
async function updatePagesKVBinding(accountId, apiToken, projectName, kvName, logs, log, kvAction = 'keep') {
  const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
  log(`处理 KV 绑定 [${kvName}]...`);

  async function findKvNamespace() {
    const res = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
      { headers },
      30000
    );
    const data = await res.json();
    if (!data.success) throw new Error(`查询 KV 失败: ${JSON.stringify(data.errors)}`);
    return data.result.find(i => i.title === kvName) || null;
  }

  let kvId = null;
  let existing = await findKvNamespace();

  if (existing) {
    if (kvAction === 'keep') {
      log(`找到已存在同名 KV，执行保留策略...`);
      kvId = existing.id;
    } else {
      log(`找到已存在同名 KV，正在删除旧数据以清空...`);
      const delRes = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${existing.id}`,
        { method: "DELETE", headers },
        15000
      );
      const delData = await delRes.json();
      if (!delData.success) throw new Error(`删除旧 KV 失败: ${JSON.stringify(delData.errors)}`);
      
      const createRes = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
        { method: "POST", headers, body: JSON.stringify({ title: kvName }) },
        30000
      );
      const createData = await createRes.json();
      if (!createData.success) throw new Error(`创建新 KV 失败: ${JSON.stringify(createData.errors)}`);
      kvId = createData.result.id;
    }
  } else {
    const createRes = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
      { method: "POST", headers, body: JSON.stringify({ title: kvName }) },
      30000
    );
    const createData = await createRes.json();
    if (!createData.success) throw new Error(`创建新 KV 失败: ${JSON.stringify(createData.errors)}`);
    kvId = createData.result.id;
  }

  const projRes = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
    { headers },
    30000
  );
  const projData = await projRes.json();
  if (!projData.success) throw new Error(`获取 Pages 项目失败`);

  const prodConfig = projData.result.deployment_configs?.production || {};
  const prevConfig = projData.result.deployment_configs?.preview || {};
  
  const updatedKvNamespaces = { ...prodConfig.kv_namespaces, KV: { namespace_id: kvId } };
  const updatedPrevKvNamespaces = { ...prevConfig.kv_namespaces, KV: { namespace_id: kvId } };
  
  const patchBody = {
    deployment_configs: {
      production: { kv_namespaces: updatedKvNamespaces },
      preview: { kv_namespaces: updatedPrevKvNamespaces }
    }
  };

  const patchRes = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
    { method: "PATCH", headers, body: JSON.stringify(patchBody) },
    30000
  );
  const patchData = await patchRes.json();
  if (!patchData.success) throw new Error(`更新绑定失败`);
  log(`[成功] KV 绑定已更新`);
}

async function deployPagesCore(accountId, apiToken, kvName, projectName, zipUrl, kvAction = 'keep') {
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
    const check = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, { headers }, 30000);
    if (check.status === 404) {
      const create = await (await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, { method: "POST", headers, body: JSON.stringify({ name: projectName, production_branch: "main" }) }, 30000)).json();
      if (!create.success) throw new Error(`创建失败`);
    }

    if (kvName && kvName.trim()) {
      log(`[4/6] 更新 KV 绑定...`);
      await updatePagesKVBinding(accountId, apiToken, projectName, kvName.trim(), logs, log, kvAction);
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
    form.append("branch", "main"); 

    for (const file of files) {
      if (file.path === "_worker.js") continue;
      form.append("/" + file.path, new Blob([file.data]), file.path.split("/").pop() || "file");
    }

    if (workerFile) form.append("_worker.js", new Blob([workerFile.data], { type: "application/javascript+module" }), "_worker.js");

    const deployRes = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`, { method: "POST", headers: { "Authorization": `Bearer ${apiToken}` }, body: form }, 60000);
    const deployData = await deployRes.json();
    if (!deployData.success) throw new Error(`部署失败`);

    log(`[成功] 部署完毕 ID: ${deployData.result.id}`);
    return { success: true, logs, deploymentId: deployData.result.id, projectName, status: 200 };
    
  } catch (err) {
    log(`[错误] ${err.message}`);
    return { success: false, error: err.message, logs, status: 500 };
  }
}

// ==================== 统一部署分发 ====================
async function deployByType(type, id, token, kv, name, source, kvAction = 'keep') {
  const t = String(type || "").toLowerCase();
  const src = source || "default";
  if (!t || !id || !token || !name) return { success: false, error: "参数缺失", logs: ["ERR"], status: 400 };
  if (t === "worker") return deployWorkerCore(id, token, kv || "", name, src, kvAction);
  if (t === "page" || t === "pages") return deployPagesCore(id, token, kv || "", name, src, kvAction);
  return { success: false, error: "type 无效", logs: ["ERR"], status: 400 };
}

async function handleUnifiedDeploy(request) {
  const ct = request.headers.get("Content-Type") || "";
  let p = {};
  if (ct.includes("application/json")) {
    const b = await request.json().catch(() => ({}));
    p = { type: b.type, id: b.id || b.accountid, token: b.token, kv: b.kv || b.kvname, kvAction: b.kvAction || b.kvaction || 'keep', name: b.name || b.projectname, source: b.source || b.codeurl || b.zipurl || b.url };
  } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    p = { type: fd.get("type"), id: fd.get("id") || fd.get("accountid"), token: fd.get("token"), kv: fd.get("kv") || fd.get("kvname"), kvAction: fd.get("kvAction") || fd.get("kvaction") || 'keep', name: fd.get("name") || fd.get("projectname"), source: fd.get("source") || fd.get("codeurl") || fd.get("zipurl") || fd.get("url") };
  }
  const result = await deployByType(p.type, p.id, p.token, p.kv, p.name, p.source, p.kvAction);
  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleGetDeploy(url) {
  const q = url.searchParams;
  const result = await deployByType(q.get("type"), q.get("accountid") || q.get("id"), q.get("token"), q.get("kvname") || q.get("kv"), q.get("projectname") || q.get("name"), q.get("codeurl") || q.get("source") || q.get("zipurl") || "default", q.get("kvAction") || 'keep');
  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleDeployWorker(request) {
  const b = await request.json().catch(() => ({}));
  const r = await deployWorkerCore(b.accountId, b.apiToken, b.kvName, b.workerName, b.codeUrl, b.kvAction || 'keep');
  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json" } });
}

async function handleDeployPages(request) {
  const b = await request.json().catch(() => ({}));
  const r = await deployPagesCore(b.accountId, b.apiToken, b.kvName, b.projectName, b.zipUrl, b.kvAction || 'keep');
  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json" } });
}

// ==================== 账户管理 API ====================
async function handleGetAccounts(env) {
  return new Response(JSON.stringify({ success: true, accounts: await getAccountsList(env) }), { headers: { "Content-Type": "application/json" } });
}

async function handlePostAccount(request, env) {
  try {
    const body = await request.json();
    if (!body?.identifier) return new Response(JSON.stringify({ success: false, error: "标识必填" }), { status: 400 });
    const { accounts, idx } = await findAccountIndex(env, body.identifier);
    if (idx >= 0) accounts[idx] = body; else accounts.push(body);
    await saveAccountsList(env, accounts);
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  }
}

async function handleDeleteAccount(url, env) {
  const identifier = url.searchParams.get("identifier");
  const { accounts, idx } = await findAccountIndex(env, identifier);
  if (idx >= 0) { accounts.splice(idx, 1); await saveAccountsList(env, accounts); return new Response(JSON.stringify({ success: true })); }
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
  
  /* 修复: 只针对非 checkbox 类型的输入框应用 100% 宽度 */
  input:not([type="checkbox"]):not([type="file"]), select {
    width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px;
    outline: none; transition: border-color 0.2s, box-shadow 0.2s; background: #fafbfc;
  }
  input:not([type="checkbox"]):not([type="file"]):focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(243, 128, 32, 0.1); background: #fff; }
  select:disabled { background: #f1f2f6; color: #a4b0be; cursor: not-allowed; }
  
  /* 修复: 为 checkbox 设置自适应宽度，确保能正常同行显示 */
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
  
  /* 模态弹窗全局共享样式 */
  .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.5); justify-content: center; align-items: center; z-index: 1000; padding: 15px; backdrop-filter: blur(2px); }
  .modal.active { display: flex; }
  .modal-content { background: #fff; padding: 20px; border-radius: 12px; width: 100%; max-width: 700px; max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
  
  /* 密码框开合眼统一样式 */
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
      <h2>🚀 Cloudflare 部署工具</h2>
      <div class="form-group"><label>Account ID</label><input type="text" id="accountId" placeholder="例如：8ab2...c8d0"></div>
      <div class="form-group"><label>API Token</label>
		  <div class="pwd-wrap">
			<input type="password" id="apiToken" placeholder="例如：cfcut_...">
			<div class="pwd-toggle" onclick="togglePwd(this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></div>
		  </div>
	  </div>
      <div class="form-group" style="display: flex; gap: 10px; align-items: flex-end;">
        <div style="flex: 1;"><label>KV 名称（可选）</label><input type="text" id="kvName" placeholder="保留原绑定留空即可"></div>
        <div style="width: 90px;"><select id="kvAction" disabled><option value="keep">保留</option><option value="clear">清空</option></select></div>
      </div>
      <div class="form-group"><label>项目名称</label><input type="text" id="projectName" placeholder="Worker或Pages名称"></div>

      <div class="accordion">
        <div class="accordion-header" data-target="workerPanel"><span>🚀 Worker 部署</span><span class="arrow">▶</span></div>
        <div id="workerPanel" class="accordion-content">
          <div class="form-group"><label>代码源地址</label><input type="url" id="workerCodeUrl" value="https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js"></div>
          <button id="btnDeployWorker" class="btn-primary action-btn">开始部署 Worker</button>
        </div>
      </div>
      <div class="accordion">
        <div class="accordion-header" data-target="pagesPanel"><span>📄 Pages 部署</span><span class="arrow">▶</span></div>
        <div id="pagesPanel" class="accordion-content">
          <div class="form-group"><label>ZIP 文件地址</label><input type="url" id="pagesZipUrl" value="https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip"></div>
          <button id="btnDeployPages" class="btn-primary action-btn">开始部署 Pages</button>
        </div>
      </div>

      <div style="margin-top: 20px;"><label style="font-size:13px; font-weight:500;">部署日志</label><textarea id="logOutput" readonly placeholder="日志输出..."></textarea></div>

      <div class="accordion" style="margin-top: 15px;">
        <div class="accordion-header" data-target="infoPanel"><span>📘 使用说明</span><span class="arrow">▶</span></div>
        <div id="infoPanel" class="accordion-content">
          <div class="info-section">
            <h3>📄 页面部署</h3>
            <p>在表单中填写 Account ID、API Token、KV 名称（可选）和项目名称，然后选择对应的部署面板（Worker 或 Pages），填写代码源地址并点击部署按钮。</p>
            <p><strong>Worker 示例：</strong></p>
            <pre><code>Account ID: 8ab2...c8d0
API Token: cfcut_...
KV 名称: MY_KV_STORE （可留空）
项目名称: my-worker-app
代码源地址: https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js</code></pre>
            <p><strong>Pages 示例：</strong></p>
            <pre><code>Account ID: 8ab2...c8d0
API Token: cfcut_...
KV 名称: MY_KV_STORE （可留空）
项目名称: my-pages-site
ZIP 地址: https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip</code></pre>
          </div>
          <div class="info-section">
            <h3>📡 POST 部署</h3>
            <p>向 <code>/api/deploy</code> 发送 POST 请求，支持 JSON 或传统表单格式。</p>
            <p style="color: #e74c3c; font-weight: 500; font-size: 12px; margin: 5px 0 10px;">※ 安全提示：如果您在环境变量配置了 AUTH_PASSWORD 密码，API 请求必须携带密码（通过 URL 参数 ?pwd=密码 或 Header头 Authorization: Bearer 密码）。</p>
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
    kv: "MY_KV_STORE",
    kvAction: "keep",
    name: "my-worker-app",
    source: "default"
  })
}).then(res => res.json()).then(console.log);</code></pre>
            <p><strong>cURL JSON 格式（使用 URL 传参鉴权）：</strong></p>
            <pre><code>curl -X POST "https://your-worker.workers.dev/api/deploy?pwd=您的系统访问密码" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "worker",
    "id": "YOUR_ACCOUNT_ID",
    "token": "YOUR_API_TOKEN",
    "kv": "MY_KV_STORE",
    "kvAction": "keep",
    "source": "default",
    "name": "my-worker-app"
  }'</code></pre>
            <p><strong>cURL 表单格式（使用 Header 鉴权）：</strong></p>
            <pre><code>curl -X POST "https://your-worker.workers.dev/api/deploy" \\
  -H "Authorization: Bearer 您的系统访问密码" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "type=worker&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvname=MY_KV_STORE&kvAction=keep&projectname=my-worker-app&codeurl=default"</code></pre>
            <p>Pages 部署只需将 <code>type</code> 改为 <code>page</code>，源地址参数可用 <code>zipurl</code> 或 <code>source</code>。</p>
          </div>
          <div class="info-section">
            <h3>🔗 GET 部署</h3>
            <p>直接在浏览器地址栏或脚本中通过 URL 调用。</p>
            <p style="color: #e74c3c; font-weight: 500; font-size: 12px; margin: 5px 0 10px;">※ 安全提示：若开启了密码保护，必须在 URL 任意位置追加 &pwd=您的系统访问密码</p>
            <pre><code>https://your-worker.workers.dev/api/deploy?type=worker&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvname=&projectname=my-worker-app&codeurl=default&pwd=您的系统访问密码</code></pre>
            <p>Pages 部署示例：</p>
            <pre><code>https://your-worker.workers.dev/api/deploy?type=page&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvname=&projectname=my-pages-site&zipurl=https://example.com/site.zip&pwd=您的系统访问密码</code></pre>
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
      <h3 style="margin-bottom:15px; font-size:16px;">✨ 发现系统新版本</h3>
      <p id="updateModalText" style="font-size: 13px; color: #475569; margin-bottom: 20px; white-space: pre-wrap; line-height: 1.6;"></p>
      <div style="display:flex; gap:10px;">
        <button id="btnConfirmUpdate" class="btn-primary" style="background:#10b981; flex:1;">🚀 更新</button>
        <button id="btnCancelUpdate" class="btn-danger" style="background:#f1f5f9; color:#475569; flex:1;">忽略</button>
      </div>
    </div>
  </div>

  <script>
    (function(){
      // 预先拉取账户数据以备自动更新使用
      let allAccountsForUpdate = [];
      fetch('/api/accounts').then(res => res.json()).then(data => {
        if (data.success) allAccountsForUpdate = data.accounts || [];
      }).catch(err => console.error('账户列表加载失败', err));

      // 获取版本号并对比
      fetch('https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/version.json')
        .then(res => res.json())
        .then(data => {
          const vBtn = document.getElementById('versionBtn');
          if (vBtn && data.version) {
            const latestVersion = data.version;
            if (latestVersion !== '${CURRENT_VERSION}') {
              vBtn.textContent = '🎁 发现新版 v' + latestVersion;
              vBtn.style.backgroundColor = '#10b981';
              vBtn.style.color = '#fff';
              
              // 绑定呼出弹窗的事件
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

      // 弹窗：关闭
      document.getElementById('btnCancelUpdate')?.addEventListener('click', () => {
        document.getElementById('updateModal').classList.remove('active');
      });

      // 弹窗：确认更新
      document.getElementById('btnConfirmUpdate')?.addEventListener('click', async () => {
        document.getElementById('updateModal').classList.remove('active');
        const output = document.getElementById('logOutput');
        output.value = '准备自动更新系统...\\n';
        
        // 尝试从列表中找出对应的 AccountID 和 Token
        const domain = window.location.hostname; // 获取当前网站域名
        
        // 匹配逻辑：1. 标识包含当前域名 2. 账号下有名为 'install' 的 worker 3. 实在没有就用第一个
        let targetAcc = allAccountsForUpdate.find(a => domain.includes(a.identifier) || (a.identifier && a.identifier.includes(domain)));
        if (!targetAcc) targetAcc = allAccountsForUpdate.find(a => a.workers && a.workers.some(w => w.name === 'install'));
        if (!targetAcc && allAccountsForUpdate.length > 0) targetAcc = allAccountsForUpdate[0];
        
        if (!targetAcc) {
           output.value += '[错误] 无法定位部署账户，请先在【常用部署】中配置相关 AccountID 及 Token。\\n';
           return;
        }
        
        // 如果账户原配置存在 install 的 KV 配置，则复用，否则留空以便默认 keep
        let kvName = "";
        const installWorker = targetAcc.workers ? targetAcc.workers.find(w => w.name === 'install') : null;
        if (installWorker && installWorker.kvName) kvName = installWorker.kvName;
        
        output.value += '[信息] 匹配账户标识: ' + targetAcc.identifier + '\\n';
        output.value += '[信息] 目标更新项目: install\\n';
        output.scrollTop = output.scrollHeight;

        const payload = {
          accountId: targetAcc.accountId,
          apiToken: targetAcc.token,
          kvName: kvName,
          kvAction: 'keep', // KV 保留
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

      document.querySelectorAll('.accordion-header').forEach(h => h.addEventListener('click', function(){
        const target = document.getElementById(this.dataset.target);
        const isActive = target.classList.contains('active');
        document.querySelectorAll('.accordion-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.accordion-header .arrow').forEach(a => a.textContent = '▶');
        if (!isActive) { target.classList.add('active'); this.querySelector('.arrow').textContent = '▼'; }
      }));

      async function runDeploy(type) {
        const accountId = document.getElementById('accountId').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const kvName = document.getElementById('kvName').value.trim();
        const kvActionVal = document.getElementById('kvAction').value;
        const name = document.getElementById('projectName').value.trim();
        const src = document.getElementById(type === 'worker' ? 'workerCodeUrl' : 'pagesZipUrl').value.trim();
        if (!accountId || !apiToken || !name) return alert('请填写必填项');
        
        const output = document.getElementById('logOutput');
        output.value = '部署中...\\n'; output.scrollTop = output.scrollHeight;
        
        const payload = type === 'worker' 
          ? {accountId, apiToken, kvName, kvAction: kvActionVal, workerName: name, codeUrl: src}
          : {accountId, apiToken, kvName, kvAction: kvActionVal, projectName: name, zipUrl: src};
          
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
    
    .project-list { display: none; padding: 12px; border-top: 1px solid var(--border); }
    .project-list.active { display: block; }

    /* 强制在移动端也是双列网格布局，拒绝单行堆叠 */
    .project-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
    .project-column { background: #fff; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; min-width: 0; }
    .column-header { background: #f8fafc; padding: 10px 12px; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; border-bottom: 1px solid var(--border); }
    .column-content { padding: 4px 10px 10px 10px; }

    .project-item { padding: 8px 0; border-bottom: 1px solid #f1f2f6; }
    .project-item:last-child { border-bottom: none; }
    .project-title { display: flex; align-items: center; cursor: pointer; font-size: 13px; color: #334155; }
    .project-details { display: none; margin-top: 4px; padding-left: 24px; font-size: 11px; color: #94a3b8; line-height: 1.4; word-break: break-all; }
    .project-details.active { display: block; }
    
    .temp-deploy-block { background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; align-items: center; }
    .temp-cb-wrap { font-size: 13px; font-weight: 500; color: #475569; display: flex; align-items: center; }
    
    .deploy-btn { width: 100%; padding: 12px; font-size: 15px; margin-top: 15px; }
    @media (max-width: 600px) {
      /* 移动端细微调整：减小 padding，保留双列 */
      .project-columns { gap: 6px; }
      .column-header { padding: 8px; font-size: 12px; }
      .project-title { font-size: 12px; }
      .temp-deploy-block { grid-template-columns: 1fr 1fr; } /* 临时部署框在手机上两行两列 */
    }
  </style></head><body>
  <div class="container">
    <div class="card">
      <h2>📋 常用部署清单</h2>
      <div id="accountList"></div>
      <button id="btnDeploySelected" class="btn-primary deploy-btn">一键部署所选项目</button>
      <div style="margin-top: 15px;"><textarea id="logOutput" readonly placeholder="日志将在此输出..."></textarea></div>
      <div class="nav-links">
        <a href="/accounts">👤 账户设置</a>
        <a href="/">🏠 返回主页</a>
        <a href="/logout" class="danger-link">🚪 退出登录</a>
      </div>
    </div>
  </div>
  <script>
    let allAccounts = [];
    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) { allAccounts = data.accounts || []; renderAccounts(); }
    }
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text||''; return div.innerHTML; }
    
    function renderAccounts() {
      const container = document.getElementById('accountList');
      container.innerHTML = '';
      let visibleCount = 0;
      
      allAccounts.forEach((account, accIndex) => {
        if (account.show === false) return;
        visibleCount++;
        const activeWorkers = account.workers ? account.workers.filter(w => w.show !== false) : [];
        const activePages = account.pages ? account.pages.filter(p => p.show !== false) : [];
        
        const accDiv = document.createElement('div');
        accDiv.className = 'account-item';
        accDiv.innerHTML = 
          '<div class="account-header" data-acc-index="' + accIndex + '">' +
            '<div style="display:flex; align-items:center;"><input type="checkbox" class="account-checkbox" data-acc-index="' + accIndex + '"><span class="account-name">' + escapeHtml(account.identifier) + '</span></div>' +
            '<span class="arrow" style="color:#94a3b8; font-size:12px;">▼</span>' +
          '</div>' +
          '<div class="project-list">' +
            '<div class="project-columns">' +
              '<div class="project-column">' +
                '<div class="column-header" data-acc-index="' + accIndex + '" data-group="worker"><input type="checkbox" class="group-checkbox" data-acc-index="' + accIndex + '" data-group="worker"> 🚀 Workers</div>' +
                '<div class="column-content">' + renderProjects(activeWorkers, 'worker', accIndex) + '</div>' +
              '</div>' +
              '<div class="project-column">' +
                '<div class="column-header" data-acc-index="' + accIndex + '" data-group="page"><input type="checkbox" class="group-checkbox" data-acc-index="' + accIndex + '" data-group="page"> 📄 Pages</div>' +
                '<div class="column-content">' + renderProjects(activePages, 'page', accIndex) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="temp-deploy-block">' +
              '<label class="temp-cb-wrap"><input type="checkbox" class="temp-checkbox" data-acc-index="' + accIndex + '"> 临时部署</label>' +
              '<select class="temp-type" data-acc-index="' + accIndex + '"><option value="worker">Worker</option><option value="page">Pages</option></select>' +
              '<input type="text" class="temp-name" data-acc-index="' + accIndex + '" placeholder="项目名称">' +
              '<input type="text" class="temp-kv" data-acc-index="' + accIndex + '" placeholder="KV名(可选)">' +
              '<select class="temp-kv-action" data-acc-index="' + accIndex + '" disabled><option value="keep">保留</option><option value="clear">清空</option></select>' +
              '<input type="text" class="temp-source" data-acc-index="' + accIndex + '" placeholder="源地址(可选)">' +
            '</div>' +
          '</div>';
        container.appendChild(accDiv);
      });
      
      if (visibleCount === 0) { container.innerHTML = '<p style="text-align:center; color:#94a3b8; font-size:13px; margin:20px 0;">暂无显示的账户，请前往设置添加。</p>'; return; }

      // 展开/收起事件
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

      // 复选框联动
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

    function renderProjects(projects, type, accIndex) {
      if (!projects || projects.length === 0) return '<div style="padding:10px 0; color:#cbd5e1; text-align:center; font-size:12px;">无</div>';
      return projects.map(proj => {
        const kvDisp = proj.kvName ? proj.kvName + ' (' + (proj.kvAction === 'clear' ? '清空' : '保留') + ')' : '(留空/保留)';
        return '<div class="project-item">' +
          '<div class="project-title"><input type="checkbox" class="project-checkbox normal-checkbox" data-acc-index="' + accIndex + '" data-type="' + type + '" data-name="' + escapeHtml(proj.name) + '">' +
          '<span class="name">' + escapeHtml(proj.name) + '</span></div>' +
          '<div class="project-details"><div>KV: ' + escapeHtml(kvDisp) + '</div><div>源: ' + escapeHtml(proj.codeUrl || '默认') + '</div></div></div>';
      }).join('');
    }

    document.getElementById('btnDeploySelected').addEventListener('click', async function() {
      const btn = this, output = document.getElementById('logOutput'), selected = [];
      document.querySelectorAll('.normal-checkbox:checked, .temp-checkbox:checked').forEach(cb => {
        const accIndex = parseInt(cb.dataset.accIndex), account = allAccounts[accIndex];
        if (cb.classList.contains('temp-checkbox')) {
          const type = document.querySelector('.temp-type[data-acc-index="' + accIndex + '"]').value;
          const name = document.querySelector('.temp-name[data-acc-index="' + accIndex + '"]').value.trim();
          const kvName = document.querySelector('.temp-kv[data-acc-index="' + accIndex + '"]').value.trim();
          const kvAction = document.querySelector('.temp-kv-action[data-acc-index="' + accIndex + '"]').value;
          const codeUrl = document.querySelector('.temp-source[data-acc-index="' + accIndex + '"]').value.trim();
          if (name) selected.push({ type, account, proj: { name, kvName, kvAction, codeUrl: codeUrl || 'default' } });
        } else {
          const type = cb.dataset.type, name = cb.dataset.name;
          const proj = type === 'worker' ? account.workers.find(w => w.name === name) : account.pages.find(p => p.name === name);
          if (proj) selected.push({ type, account, proj });
        }
      });
      if (selected.length === 0) return alert('请先勾选需要部署的项目');
      
      btn.disabled = true; output.value = '开始批量部署...\\n';
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        output.value += '\\n[' + (i+1) + '/' + selected.length + '] ' + item.account.identifier + ' -> ' + item.proj.name + '\\n';
        output.scrollTop = output.scrollHeight;
        try {
          const payload = { type: item.type, id: item.account.accountId, token: item.account.token, kv: item.proj.kvName || '', kvAction: item.proj.kvAction || 'keep', name: item.proj.name, source: item.proj.codeUrl || 'default' };
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

// ==================== 账户管理页面 ====================
function getAccountsPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>账户设置</title><style>${GLOBAL_STYLE}
    .action-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .action-bar button { padding: 10px; font-size: 13px; }
    
    .account-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 15px; background: #fff; overflow: hidden; }
    .account-header { background: #fafbfc; padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; transition: 0.2s; }
    .account-header:hover { background: #f1f2f6; }
    .account-header-left { flex: 1; min-width: 0; display: flex; align-items: center; }
    .account-header-left h3 { font-size: 15px; font-weight: 600; margin: 0; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; }
    .account-header-right { display: flex; gap: 4px; flex-shrink: 0; align-items: center; }
    
    .project-list { display: none; padding: 15px; border-top: 1px solid var(--border); }
    .project-list.active { display: block; }
    
    .project-detail { background: #fff; border: 1px solid #f1f2f6; padding: 8px 10px; margin: 4px 0; border-radius: 6px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 2px rgba(0,0,0,0.01); }
    .project-detail-info { flex: 1; min-width: 0; color: #64748b; line-height: 1.4; }
    .project-detail-info b { color: #334155; font-size: 13px; }
    .project-detail-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 10px; }

    .form-group { margin-bottom: 12px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 5px; color: #475569; }
    
    .dynamic-list { margin-top: 8px; }
    .dynamic-item { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; position: relative; }
    @media (min-width: 600px) { .dynamic-item { display: flex; align-items: center; flex-wrap: nowrap; } .dynamic-item input[type="text"] { flex: 1; min-width: 80px; } }
    .item-actions { display: flex; gap: 4px; justify-content: flex-end; grid-column: span 2; }
    @media (min-width: 600px) { .item-actions { grid-column: auto; } }
    .add-btn { background: #e2e8f0; color: #475569; padding: 8px 12px; font-size: 13px; margin-top: 4px; }
    .add-btn:hover { background: #cbd5e1; }
  </style></head><body>
  <div class="container">
    <div class="card">
      <h2>👤 账户与配置管理</h2>
      
      <div class="action-bar">
        <button id="btnBackup" class="btn-primary" style="background:#10b981;">💾 备份配置</button>
        <button id="btnShowRestore" class="btn-primary" style="background:#f59e0b;">⏪ 恢复配置</button>
        <button id="btnExport" class="btn-primary" style="background:#8b5cf6;">📤 导出全部</button>
        <button id="btnImport" class="btn-primary" style="background:#3b82f6;">📥 导入配置</button>
        <input type="file" id="importFile" style="display:none" accept=".json">
      </div>

      <div id="accountList"></div>
      <button id="btnAdd" class="btn-primary" style="width:100%; padding:12px; margin-top:10px;">➕ 添加新账户</button>
      
      <div class="nav-links">
        <a href="/dashboard">📋 常用部署</a>
        <a href="/">🏠 返回主页</a>
      </div>
    </div>
  </div>

  <div id="editModal" class="modal">
    <div class="modal-content">
      <h3 id="modalTitle" style="margin-bottom:15px; font-size:16px;">编辑账户</h3>
      <div class="form-group"><label>标识名称</label><input type="text" id="editIdentifier" placeholder="任意自定义名称"></div>
      <div class="form-group"><label>Account ID</label><input type="text" id="editAccountId"></div>
      <div class="form-group"><label>API Token</label>
		  <div class="pwd-wrap">
			<input type="password" id="editToken">
			<div class="pwd-toggle" onclick="togglePwd(this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></div>
		  </div>
	  </div>
      <div class="form-group"><label style="display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="editAccountShow" checked> 在部署页显示此账户</label></div>
      
      <div class="form-group"><label>🚀 Workers 项目</label><div id="workerList" class="dynamic-list"></div><button id="btnAddWorker" class="add-btn">➕ 添加 Worker</button></div>
      <div class="form-group"><label>📄 Pages 项目</label><div id="pagesList" class="dynamic-list"></div><button id="btnAddPage" class="add-btn">➕ 添加 Pages</button></div>
      
      <div style="display:flex; gap:10px; margin-top:20px;">
        <button id="btnSave" class="btn-primary" style="flex:1; padding:10px;">保存</button>
        <button id="btnCancel" class="btn-danger" style="flex:1; padding:10px; background:#f1f5f9; color:#475569;">取消</button>
      </div>
    </div>
  </div>

  <div id="restoreModal" class="modal">
    <div class="modal-content" style="max-width: 400px;">
      <h3 style="margin-bottom:15px; font-size:16px;">⏪ 选择备份进行恢复</h3>
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
    const ICONS = ${JSON.stringify(ICONS)};
    let accounts = [];
    let editingIdentifier = null;

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) { accounts = data.accounts || []; renderAccounts(); }
    }
    async function saveAccountsOrder() {
      await fetch('/api/accounts/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts }) });
      renderAccounts();
    }
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text||''; return div.innerHTML; }
    function moveArrItem(arr, idx, dir) { const t = idx+dir; if(t<0||t>=arr.length) return false; [arr[idx], arr[t]] = [arr[t], arr[idx]]; return true; }

    function renderAccounts() {
      const container = document.getElementById('accountList');
      container.innerHTML = '';
      if (accounts.length === 0) { container.innerHTML = '<p style="text-align:center; color:#94a3b8; font-size:13px; margin:20px 0;">暂无数据，请添加。</p>'; return; }
      
      accounts.forEach((acc, accIdx) => {
        const div = document.createElement('div'); div.className = 'account-item';
        const hideTag = acc.show === false ? ' <span style="color:#ef4444;font-size:12px;font-weight:normal;margin-left:5px;">[隐藏]</span>' : '';
        const disUp = accIdx===0?'disabled':'', disDn = accIdx===accounts.length-1?'disabled':'';
        
        let htmlStr = '<div class="account-header">' +
          '<div class="account-header-left"><h3>' + escapeHtml(acc.identifier) + hideTag + '</h3></div>' +
          '<div class="account-header-right">' +
            '<button class="btn-icon move-acc-up" ' + disUp + ' data-idx="' + accIdx + '">' + ICONS.up + '</button>' +
            '<button class="btn-icon move-acc-down" ' + disDn + ' data-idx="' + accIdx + '">' + ICONS.down + '</button>' +
            '<button class="btn-icon edit-btn" data-id="' + escapeHtml(acc.identifier) + '" style="color:var(--primary)">' + ICONS.edit + '</button>' +
            '<button class="btn-icon delete-btn" data-id="' + escapeHtml(acc.identifier) + '" style="color:#ef4444">' + ICONS.del + '</button>' +
            '<span class="arrow" style="color:#94a3b8; font-size:12px; margin-left:8px;">▼</span>' +
          '</div></div><div class="project-list">';
        
        let pListHTML = '';
        const renderProj = (list, typeName, typeKey) => {
          if(!list || !list.length) return '';
          let h = '<p style="font-size:13px; font-weight:600; color:#334155; margin:10px 0 5px;">' + typeName + '</p>';
          list.forEach((p, i) => {
            const hTag = p.show===false ? '<span style="color:#ef4444">[隐藏]</span> ' : '';
            const kvInfo = p.kvName ? 'KV: ' + p.kvName + (p.kvAction==='clear'?'(清)':'') : '无KV';
            const uDis = i===0?'disabled':'', dDis = i===list.length-1?'disabled':'';
            h += '<div class="project-detail"><div class="project-detail-info">' + hTag + '<b>' + escapeHtml(p.name) + '</b> <br><span style="font-size:11px;">' + escapeHtml(kvInfo) + ' | 源: ' + escapeHtml(p.codeUrl||'默认') + '</span></div>' +
              '<div class="project-detail-actions">' +
                '<button class="btn-icon move-proj-up" ' + uDis + ' data-acc="' + accIdx + '" data-type="' + typeKey + '" data-idx="' + i + '">' + ICONS.up + '</button>' +
                '<button class="btn-icon move-proj-down" ' + dDis + ' data-acc="' + accIdx + '" data-type="' + typeKey + '" data-idx="' + i + '">' + ICONS.down + '</button>' +
              '</div></div>';
          }); return h;
        };
        
        pListHTML += renderProj(acc.workers, '🚀 Workers', 'workers');
        pListHTML += renderProj(acc.pages, '📄 Pages', 'pages');
        if(!pListHTML) pListHTML = '<div style="color:#94a3b8; font-size:12px; text-align:center;">暂无项目</div>';
        
        htmlStr += pListHTML + '</div>';
        div.innerHTML = htmlStr;
        container.appendChild(div);
      });

      document.querySelectorAll('.account-header').forEach(h => h.addEventListener('click', function(e){
        if (e.target.closest('button')) return;
        const list = this.nextElementSibling;
        list.classList.toggle('active');
        const arrow = this.querySelector('.arrow');
        if (arrow) arrow.textContent = list.classList.contains('active') ? '▲' : '▼';
      }));
      document.querySelectorAll('.move-acc-up').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if(moveArrItem(accounts, parseInt(b.dataset.idx), -1)) saveAccountsOrder(); }));
      document.querySelectorAll('.move-acc-down').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if(moveArrItem(accounts, parseInt(b.dataset.idx), 1)) saveAccountsOrder(); }));
      document.querySelectorAll('.move-proj-up').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if(moveArrItem(accounts[b.dataset.acc][b.dataset.type], parseInt(b.dataset.idx), -1)) saveAccountsOrder(); }));
      document.querySelectorAll('.move-proj-down').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if(moveArrItem(accounts[b.dataset.acc][b.dataset.type], parseInt(b.dataset.idx), 1)) saveAccountsOrder(); }));
      
      document.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openEdit(b.dataset.id); }));
      document.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation(); if (confirm('删除账户 ' + b.dataset.id + '？')) { await fetch('/api/accounts?identifier=' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }); loadAccounts(); }
      }));
    }

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
        } catch(err) { alert('❌ JSON 解析失败'); }
        document.getElementById('importFile').value = '';
      }; reader.readAsText(file);
    });

    /* 编辑弹窗逻辑 */
    function buildDynamicRow(type, name='', kvName='', codeUrl='', kvAction='keep', show=true) {
      const div = document.createElement('div'); div.className = 'dynamic-item';
      
      // 修复：为下拉框 i-action 增加内联样式：width:75px 和 flex-shrink:0，防止挤占 codeUrl 空间
      div.innerHTML = 
        '<input type="text" class="i-name" placeholder="名称" value="' + escapeHtml(name) + '">' +
        '<input type="text" class="i-kv" placeholder="KV名称" value="' + escapeHtml(kvName) + '">' +
        '<select class="i-action" style="width:75px; flex-shrink:0; padding-left:4px; padding-right:4px;" ' + (!kvName?'disabled':'') + '><option value="keep" '+(kvAction==='keep'?'selected':'')+'>保留</option><option value="clear" '+(kvAction==='clear'?'selected':'')+'>清空</option></select>' +
        '<input type="text" class="i-url" placeholder="代码源/ZIP地址" value="' + escapeHtml(codeUrl) + '">' +
        '<div class="item-actions">' +
          '<label style="display:flex;align-items:center;margin-right:10px;"><input type="checkbox" class="i-show" '+(show!==false?'checked':'')+'> 显示</label>' +
          '<button class="btn-icon u-btn">' + ICONS.up + '</button>' +
          '<button class="btn-icon d-btn">' + ICONS.down + '</button>' +
          '<button class="btn-icon r-btn" style="color:#ef4444">' + ICONS.del + '</button>' +
        '</div>';
      
      div.querySelector('.i-kv').addEventListener('input', function() { div.querySelector('.i-action').disabled = !this.value.trim(); });
      div.querySelector('.u-btn').addEventListener('click', function(){ if(div.previousElementSibling) div.parentNode.insertBefore(div, div.previousElementSibling); });
      div.querySelector('.d-btn').addEventListener('click', function(){ if(div.nextElementSibling) div.parentNode.insertBefore(div.nextElementSibling, div); });
      div.querySelector('.r-btn').addEventListener('click', () => div.remove());
      document.getElementById(type + 'List').appendChild(div);
    }
    
    function openAdd() {
      editingIdentifier = null; document.getElementById('modalTitle').textContent = '添加账户';
      document.getElementById('editIdentifier').value = ''; document.getElementById('editAccountId').value = ''; document.getElementById('editToken').value = '';
      document.getElementById('editAccountShow').checked = true;
      document.getElementById('workerList').innerHTML = ''; document.getElementById('pagesList').innerHTML = '';
      document.getElementById('editModal').classList.add('active');
    }
    function openEdit(id) {
      const acc = accounts.find(a => a.identifier === id); if (!acc) return;
      editingIdentifier = id; document.getElementById('modalTitle').textContent = '编辑: ' + id;
      document.getElementById('editIdentifier').value = acc.identifier; document.getElementById('editAccountId').value = acc.accountId; document.getElementById('editToken').value = acc.token;
      document.getElementById('editAccountShow').checked = acc.show !== false;
      document.getElementById('workerList').innerHTML = ''; (acc.workers||[]).forEach(w => buildDynamicRow('worker', w.name, w.kvName, w.codeUrl, w.kvAction, w.show));
      document.getElementById('pagesList').innerHTML = ''; (acc.pages||[]).forEach(p => buildDynamicRow('pages', p.name, p.kvName, p.codeUrl, p.kvAction, p.show));
      document.getElementById('editModal').classList.add('active');
    }

    document.getElementById('btnAdd').addEventListener('click', openAdd);
    document.getElementById('btnAddWorker').addEventListener('click', () => buildDynamicRow('worker'));
    document.getElementById('btnAddPage').addEventListener('click', () => buildDynamicRow('pages'));
    document.getElementById('btnCancel').addEventListener('click', () => document.getElementById('editModal').classList.remove('active'));
    
    document.getElementById('btnSave').addEventListener('click', async () => {
      const identifier = document.getElementById('editIdentifier').value.trim(), accountId = document.getElementById('editAccountId').value.trim(), token = document.getElementById('editToken').value.trim();
      if (!identifier || !accountId || !token) return alert('必填项不能为空');
      
      const getList = (id) => Array.from(document.querySelectorAll('#' + id + ' .dynamic-item')).map(el => ({
        name: el.querySelector('.i-name').value.trim(), kvName: el.querySelector('.i-kv').value.trim(),
        kvAction: el.querySelector('.i-action').value, codeUrl: el.querySelector('.i-url').value.trim(),
        show: el.querySelector('.i-show').checked
      })).filter(i => i.name);
      
      const payload = { identifier, accountId, token, show: document.getElementById('editAccountShow').checked, workers: getList('workerList'), pages: getList('pagesList') };
      const data = await (await fetch('/api/accounts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })).json();
      if (data.success) { document.getElementById('editModal').classList.remove('active'); loadAccounts(); } else alert('保存失败');
    });
    
    loadAccounts();
  </script>
</body></html>`;
}

//2026-08-18 0639
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
              throw new Error(`解压失败（所有尝试均失败）: ${stripError.message}`);
            }
          } else {
            throw new Error(`解压失败（数据过短）: ${rawError.message}`);
          }
        }
      }
    } else {
      throw new Error(`不支持的压缩方式：${method}（文件：${name}）`);
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
      log(`旧 KV 删除成功，尝试创建全新 KV...`);
      
      const createRes = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
        { method: "POST", headers, body: JSON.stringify({ title: kvName }) },
        30000
      );
      const createData = await createRes.json();
      if (!createData.success) {
        throw new Error(`创建新 KV 失败: ${JSON.stringify(createData.errors)}`);
      }
      kvId = createData.result.id;
      log(`新 KV 创建完成，ID: ${kvId}`);
    }
  } else {
    log(`尝试创建全新 KV...`);
    const createRes = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
      { method: "POST", headers, body: JSON.stringify({ title: kvName }) },
      30000
    );
    const createData = await createRes.json();
    if (!createData.success) {
      throw new Error(`创建新 KV 失败: ${JSON.stringify(createData.errors)}`);
    }
    kvId = createData.result.id;
    log(`新 KV 创建完成，ID: ${kvId}`);
  }

  // 获取 Pages 项目当前配置并更新
  const projRes = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
    { headers },
    30000
  );
  const projData = await projRes.json();
  if (!projData.success) {
    throw new Error(`获取 Pages 项目失败: ${JSON.stringify(projData.errors)}`);
  }

  const prodConfig = projData.result.deployment_configs?.production || {};
  const prevConfig = projData.result.deployment_configs?.preview || {};
  
  const existingKvNamespaces = prodConfig.kv_namespaces || {};
  const existingPrevKvNamespaces = prevConfig.kv_namespaces || {};

  const updatedKvNamespaces = { ...existingKvNamespaces, KV: { namespace_id: kvId } };
  const updatedPrevKvNamespaces = { ...existingPrevKvNamespaces, KV: { namespace_id: kvId } };
  
  const patchBody = {
    deployment_configs: {
      production: { kv_namespaces: updatedKvNamespaces },
      preview: { kv_namespaces: updatedPrevKvNamespaces }
    }
  };

  const patchRes = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(patchBody)
    },
    30000
  );
  const patchData = await patchRes.json();
  if (!patchData.success) {
    throw new Error(`更新绑定失败: ${JSON.stringify(patchData.errors)}`);
  }
  log(`[成功] KV 绑定已更新至项目中`);
}

async function deployPagesCore(accountId, apiToken, kvName, projectName, zipUrl, kvAction = 'keep') {
  const logs = [];
  const log = (msg) => logs.push(msg);
  try {
    if (!zipUrl || zipUrl.trim() === "" || zipUrl.trim() === "default") zipUrl = DEFAULT_PAGES_ZIP_URL;
    if (!accountId || !apiToken || !projectName) {
      return { success: false, error: "缺少必填参数", logs: ["ERR: 缺少必填参数"], status: 400 };
    }
    if (!/^[a-z0-9-]+$/.test(projectName)) return { success: false, error: "项目名称格式不正确", logs: ["ERR: 名称格式"], status: 400 };

    const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
    log(`[1/6] 下载 ZIP: ${zipUrl}`);
    const zipRes = await fetchWithTimeout(zipUrl, {}, 30000);
    if (!zipRes.ok) throw new Error(`下载失败: HTTP ${zipRes.status}`);
    const zipBuf = await zipRes.arrayBuffer();
    log(`[成功] ZIP 大小: ${zipBuf.byteLength}`);

    log(`[2/6] 解压...`);
    const files = await extractZip(zipBuf);
    log(`[成功] 文件数: ${files.length}`);

    log(`[3/6] 检查/创建 Pages 项目...`);
    const check = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
      { headers },
      30000
    );
    if (check.status === 404) {
      log(`项目不存在，创建...`);
      const create = await (await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`,
        { method: "POST", headers, body: JSON.stringify({ name: projectName, production_branch: "main" }) },
        30000
      )).json();
      if (!create.success) throw new Error(`创建项目失败: ${JSON.stringify(create.errors)}`);
    } else if (!check.ok) throw new Error(`检查项目失败`);

    if (kvName && kvName.trim()) {
      log(`[4/6] 更新 KV 绑定...`);
      await updatePagesKVBinding(accountId, apiToken, projectName, kvName.trim(), logs, log, kvAction);
    } else {
      log(`[4/6] 跳过 KV 绑定`);
    }

    log(`[5/6] 构建 manifest 并组装部署表单...`);
    const manifest = {};
    let workerFile = null;

    for (const file of files) {
      if (file.path === "_worker.js") {
        workerFile = file;
        continue;
      }
      const hash = await sha256Hex(file.data);
      manifest["/" + file.path] = { hash, size: file.data.length };
    }
    log(`manifest 构建完成，静态文件数: ${Object.keys(manifest).length}`);

    log(`[6/6] 提交部署请求并上传文件...`);
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("branch", "main"); 

    for (const file of files) {
      if (file.path === "_worker.js") continue;
      const filePath = "/" + file.path;
      form.append(filePath, new Blob([file.data]), file.path.split("/").pop() || "file");
    }

    if (workerFile) {
      form.append("_worker.js", new Blob([workerFile.data], { type: "application/javascript+module" }), "_worker.js");
      log("已独立注入 _worker.js 后台引擎");
    }

    const deployRes = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiToken}` }, 
        body: form
      },
      60000 
    );

    const deployData = await deployRes.json();
    if (!deployData.success) {
      throw new Error(`部署与上传失败: ${JSON.stringify(deployData.errors)}`);
    }

    const deploymentId = deployData.result.id;
    log(`[成功] 部署 ID: ${deploymentId}`);
    return { success: true, logs, deploymentId, projectName, status: 200 };
    
  } catch (err) {
    log(`[错误] ${err.message}`);
    return { success: false, error: err.message, logs, status: 500 };
  }
}

// ==================== 统一部署分发 ====================
async function deployByType(type, id, token, kv, name, source, kvAction = 'keep') {
  const t = String(type || "").toLowerCase();
  const src = source || "default";
  if (!t || !id || !token || !name) return { success: false, error: "缺少必填参数", logs: ["ERR: 缺少参数"], status: 400 };
  if (t === "worker") return deployWorkerCore(id, token, kv || "", name, src, kvAction);
  if (t === "page" || t === "pages") return deployPagesCore(id, token, kv || "", name, src, kvAction);
  return { success: false, error: "type 无效", logs: ["ERR: type 无效"], status: 400 };
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
  } else {
    const b = await request.json().catch(() => ({}));
    p = { type: b.type, id: b.id || b.accountid, token: b.token, kv: b.kv || b.kvname, kvAction: b.kvAction || b.kvaction || 'keep', name: b.name || b.projectname, source: b.source || b.codeurl || b.zipurl || b.url };
  }
  const result = await deployByType(p.type, p.id, p.token, p.kv, p.name, p.source, p.kvAction);
  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function handleGetDeploy(url) {
  const q = url.searchParams;
  const type = (q.get("type") || "").toLowerCase();
  const id = q.get("accountid") || q.get("id") || "";
  const token = q.get("token") || "";
  const kv = q.get("kvname") || q.get("kv") || "";
  const kvAction = q.get("kvAction") || q.get("kvaction") || 'keep';
  const name = q.get("projectname") || q.get("name") || "";
  const source = q.get("codeurl") || q.get("source") || q.get("zipurl") || q.get("url") || "default";
  const result = await deployByType(type, id, token, kv, name, source, kvAction);
  return new Response(JSON.stringify(result), { status: result.status || 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function handleDeployWorker(request) {
  const b = await request.json().catch(() => ({}));
  const r = await deployWorkerCore(b.accountId, b.apiToken, b.kvName, b.workerName, b.codeUrl, b.kvAction || 'keep');
  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function handleDeployPages(request) {
  const b = await request.json().catch(() => ({}));
  const r = await deployPagesCore(b.accountId, b.apiToken, b.kvName, b.projectName, b.zipUrl, b.kvAction || 'keep');
  return new Response(JSON.stringify(r), { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// ==================== 账户管理 API ====================
async function handleGetAccounts(env) {
  const accounts = await getAccountsList(env);
  return new Response(JSON.stringify({ success: true, accounts }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function handlePostAccount(request, env) {
  try {
    const body = await request.json();
    if (!body?.identifier || !body?.accountId || !body?.token) {
      return new Response(JSON.stringify({ success: false, error: "标识、AccountID、Token 为必填" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const { accounts, idx } = await findAccountIndex(env, body.identifier);
    if (idx >= 0) accounts[idx] = body; else accounts.push(body);
    await saveAccountsList(env, accounts);
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

async function handleDeleteAccount(url, env) {
  const identifier = url.searchParams.get("identifier") || url.searchParams.get("id");
  if (!identifier) return new Response(JSON.stringify({ success: false, error: "缺少 identifier" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const { accounts, idx } = await findAccountIndex(env, identifier);
  if (idx >= 0) {
    accounts.splice(idx, 1);
    await saveAccountsList(env, accounts);
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: false, error: "账号不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

// ==================== 数据备份管理 API ====================
async function handleCreateBackup(env) {
  try {
    const raw = await env.KV.get(ACCOUNTS_KEY);
    if (!raw) return new Response(JSON.stringify({ success: false, error: "无数据可备份" }), { headers: { "Content-Type": "application/json" } });
    const d = new Date();
    d.setTime(d.getTime() + 8 * 60 * 60 * 1000); 
    const pad = n => n.toString().padStart(2, '0');
    const key = `backup_${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    await env.KV.put(key, raw);
    return new Response(JSON.stringify({ success: true, key }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleListBackups(env) {
  try {
    const listed = await env.KV.list({ prefix: "backup_" });
    return new Response(JSON.stringify({ success: true, backups: listed.keys.map(k => k.name) }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleRestoreBackup(request, env) {
  try {
    const { key } = await request.json();
    const raw = await env.KV.get(key);
    if (raw) {
      await env.KV.put(ACCOUNTS_KEY, raw);
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: false, error: "未找到该备份" }), { status: 404 });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleExportAll(env) {
  try {
    const allData = {};
    const listed = await env.KV.list(); 
    for (const k of listed.keys) {
      const val = await env.KV.get(k.name);
      if (val) allData[k.name] = val;
    }
    return new Response(JSON.stringify(allData, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="cloudflare_kv_export.json"'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleImportAll(request, env) {
  try {
    const data = await request.json();
    for (const [k, v] of Object.entries(data)) {
      await env.KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

// ==================== 前端页面 ====================

// ==================== 登录页面 ====================
function getLoginPage(errorMsg = "") {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>系统安全认证</title>
  <style>
    :root { --primary: #f38020; --bg: #f0f2f5; --card-bg: #ffffff; --text: #333333; --border: #e0e0e0; --radius: 12px; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); height: 100vh; display: flex; align-items: center; justify-content: center; color: var(--text); }
    .login-card { background: var(--card-bg); padding: 40px; border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0,0,0,0.1); width: 90%; max-width: 380px; text-align: center; }
    h2 { margin-bottom: 24px; color: #222; }
    .form-group { margin-bottom: 20px; text-align: left; }
    input { width: 100%; padding: 14px 15px; border: 1px solid var(--border); border-radius: 8px; font-size: 15px; outline: none; transition: 0.2s; }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(243, 128, 32, 0.15); }
    button { width: 100%; padding: 14px; background: var(--primary); color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #e06c11; }
    .error { color: #e74c3c; font-size: 14px; margin-bottom: 15px; background: #fdf3f2; padding: 10px; border-radius: 6px;}
  </style>
</head>
<body>
  <div class="login-card">
    <h2>🔒 Cloudflare 部署工具</h2>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
    <form method="POST" action="/login">
      <div class="form-group">
        <input type="password" name="password" placeholder="请输入系统访问密码" required autofocus>
      </div>
      <button type="submit">登 录</button>
    </form>
  </div>
</body>
</html>`;
}

// ==================== 主页面 ====================
function getMainPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare 部署工具</title>
  <style>
    :root {
      --primary: #f38020; --primary-hover: #e06c11;
      --bg: #f0f2f5; --card-bg: #ffffff;
      --text: #333333; --text-light: #666666;
      --border: #e0e0e0; --shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; color: var(--text);
    }
    .container { width: 100%; max-width: 720px; }
    .card { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px; }
    h2 { font-size: 24px; font-weight: 700; margin-bottom: 24px; color: #222; text-align: center; }
    .form-group { margin-bottom: 18px; }
    label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; color: var(--text-light); }
    input, select {
      width: 100%; padding: 12px 15px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px;
      outline: none; transition: border-color 0.2s, box-shadow 0.2s; background: #fafafa;
    }
    input:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(243, 128, 32, 0.15); background: #fff; }
    select:disabled { background: #eeeeee; color: #999; cursor: not-allowed; }
    .accordion { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 12px; background: #fff; }
    .accordion-header { background: #f7f8fa; padding: 16px 20px; cursor: pointer; font-weight: 600; font-size: 16px; display: flex; justify-content: space-between; align-items: center; user-select: none; transition: background 0.2s; }
    .accordion-header:hover { background: #f0f2f5; }
    .accordion-header .arrow { transition: transform 0.2s; }
    .accordion-content { display: none; padding: 20px; border-top: 1px solid var(--border); }
    .accordion-content.active { display: block; }
    button { width: 100%; padding: 14px; background: var(--primary); color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s, transform 0.1s; margin-top: 10px; }
    button:hover { background: var(--primary-hover); }
    button:active { transform: scale(0.98); }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .output-box { margin-top: 24px; }
    textarea { width: 100%; height: 400px; background: #1e1e2e; color: #4af626; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; padding: 15px; border-radius: 8px; border: none; resize: vertical; outline: none; }
    .info-accordion { margin-top: 24px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #fff; }
    .info-header { background: #f7f8fa; padding: 16px 20px; cursor: pointer; font-weight: 600; font-size: 16px; display: flex; justify-content: space-between; align-items: center; user-select: none; }
    .info-header:hover { background: #f0f2f5; }
    .info-content { display: none; padding: 20px; border-top: 1px solid var(--border); background: #fafbfc; }
    .info-content.active { display: block; }
    .info-section { margin-bottom: 28px; }
    .info-section h3 { font-size: 17px; font-weight: 600; margin-bottom: 10px; color: #333; }
    .info-section p { font-size: 14px; color: #555; margin-bottom: 10px; line-height: 1.6; }
    pre { background: #2d2d3f; color: #f8f8f2; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; margin-bottom: 10px; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; }
    .link-button { display: inline-block; padding: 12px 24px; background: var(--primary); color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 10px; transition: background 0.2s; }
    .link-button:hover { background: var(--primary-hover); }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h2>🚀 Cloudflare 部署工具</h2>

      <div class="form-group">
        <label>Account ID</label>
        <input type="text" id="accountId" placeholder="例如：8ab2...c8d0">
      </div>
      <div class="form-group">
        <label>API Token</label>
        <input type="password" id="apiToken" placeholder="例如：cfcut_...">
      </div>
      <div class="form-group" style="display: flex; gap: 10px; align-items: flex-end;">
        <div style="flex: 1;">
          <label>KV 名称（可选，留空保留原绑定）</label>
          <input type="text" id="kvName" placeholder="例如：MY_KV_STORE">
        </div>
        <div style="width: 100px;">
          <select id="kvAction" disabled>
            <option value="keep">保留</option>
            <option value="clear">清空</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>项目名称（Worker 或 Pages 名称）</label>
        <input type="text" id="projectName" placeholder="例如：my-project">
      </div>

      <div class="accordion">
        <div class="accordion-header" data-target="workerPanel">
          <span>🚀 Worker 部署</span>
          <span class="arrow">▶</span>
        </div>
        <div id="workerPanel" class="accordion-content">
          <div class="form-group">
            <label>代码源地址（JS 文件）</label>
            <input type="url" id="workerCodeUrl" value="https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/_worker.js">
          </div>
          <button id="btnDeployWorker">部署 Worker</button>
        </div>
      </div>

      <div class="accordion">
        <div class="accordion-header" data-target="pagesPanel">
          <span>📄 Pages 部署</span>
          <span class="arrow">▶</span>
        </div>
        <div id="pagesPanel" class="accordion-content">
          <div class="form-group">
            <label>ZIP 文件地址</label>
            <input type="url" id="pagesZipUrl" value="https://raw.githubusercontent.com/Agedmonk/cfcode/refs/heads/main/worker.zip">
          </div>
          <button id="btnDeployPages">部署 Pages</button>
        </div>
      </div>

      <div class="output-box">
        <label>状态日志</label>
        <textarea id="logOutput" readonly placeholder="部署日志将显示在这里..."></textarea>
      </div>

      <div class="info-accordion">
        <div class="info-header" id="infoHeader">
          <span>📘 使用说明</span>
          <span class="arrow">▶</span>
        </div>
        <div class="info-content" id="infoContent">
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
            <p style="color: #e74c3c; font-weight: 600; font-size: 13px; margin: 5px 0 10px;">※ 安全提示：如果您在环境变量配置了 AUTH_PASSWORD 密码，API 请求必须携带密码（通过 URL 参数 ?pwd=密码 或 Header头 Authorization: Bearer 密码）。</p>
            
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
            <p style="color: #e74c3c; font-weight: 600; font-size: 13px; margin: 5px 0 10px;">※ 安全提示：若开启了密码保护，必须在 URL 任意位置追加 &pwd=您的系统访问密码</p>
            <pre><code>https://your-worker.workers.dev/api/deploy?type=worker&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvname=&projectname=my-worker-app&codeurl=default&pwd=您的系统访问密码</code></pre>
            <p>Pages 部署示例：</p>
            <pre><code>https://your-worker.workers.dev/api/deploy?type=page&accountid=YOUR_ACCOUNT_ID&token=YOUR_API_TOKEN&kvname=&projectname=my-pages-site&zipurl=https://example.com/site.zip&pwd=您的系统访问密码</code></pre>
          </div>
        </div>
      </div>

      <div style="text-align:center; margin-top:24px; display: flex; justify-content: center; gap: 20px; flex-wrap: wrap;">
        <a href="/dashboard" class="link-button" style="margin-top:0;">📋 常用部署</a>
        <a href="/logout" class="link-button" style="margin-top:0; background: #e74c3c;">🚪 退出系统</a>
      </div>
    </div>
  </div>

  <script>
    (function(){
      // 联动控制 KV Action 下拉框
      const kvInput = document.getElementById('kvName');
      const kvAction = document.getElementById('kvAction');
      kvInput.addEventListener('input', () => {
        if (kvInput.value.trim() !== '') {
          kvAction.disabled = false;
        } else {
          kvAction.disabled = true;
        }
      });

      const headers = document.querySelectorAll('.accordion-header');
      headers.forEach(h => h.addEventListener('click', function(){
        const target = document.getElementById(this.dataset.target);
        // 1. 先记录当前点击的面板是否处于展开状态
        const isCurrentlyActive = target.classList.contains('active');
        
        // 2. 清除所有面板的展开状态和箭头方向
        document.querySelectorAll('.accordion-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.accordion-header .arrow').forEach(a => a.textContent = '▶');
        
        // 3. 如果它原本没有展开，则展开它（如果原本已展开，经过第2步就已经收起了）
        if (!isCurrentlyActive) {
          target.classList.add('active');
          this.querySelector('.arrow').textContent = '▼';
        }
      }));

      // 使用说明面板的折叠逻辑
      const ih = document.getElementById('infoHeader');
      if (ih) {
        ih.addEventListener('click', () => {
          const ic = document.getElementById('infoContent');
          ic.classList.toggle('active');
          ih.querySelector('.arrow').textContent = ic.classList.contains('active') ? '▼' : '▶';
        });
      }

      document.getElementById('btnDeployWorker').addEventListener('click', async function(){
        const accountId = document.getElementById('accountId').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const kvName = document.getElementById('kvName').value.trim();
        const kvActionVal = document.getElementById('kvAction').value;
        const workerName = document.getElementById('projectName').value.trim();
        const codeUrl = document.getElementById('workerCodeUrl').value.trim();
        if (!accountId || !apiToken || !workerName) return alert('请填写必填项');
        const output = document.getElementById('logOutput');
        output.value = '部署中...\\n';
		output.scrollTop = output.scrollHeight;
        const res = await fetch('/api/deploy-worker', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({accountId, apiToken, kvName, kvAction: kvActionVal, workerName, codeUrl})
        });
        const data = await res.json();
        output.value = (data.logs || []).join('\\n');
		output.scrollTop = output.scrollHeight;
      });

      document.getElementById('btnDeployPages').addEventListener('click', async function(){
        const accountId = document.getElementById('accountId').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const kvName = document.getElementById('kvName').value.trim();
        const kvActionVal = document.getElementById('kvAction').value;
        const projectName = document.getElementById('projectName').value.trim();
        const zipUrl = document.getElementById('pagesZipUrl').value.trim();
        if (!accountId || !apiToken || !projectName) return alert('请填写必填项');
        const output = document.getElementById('logOutput');
        output.value = '部署中...\\n';
		output.scrollTop = output.scrollHeight;
        const res = await fetch('/api/deploy-pages', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({accountId, apiToken, kvName, kvAction: kvActionVal, projectName, zipUrl})
        });
        const data = await res.json();
        output.value = (data.logs || []).join('\\n');
		output.scrollTop = output.scrollHeight;
      });
    })();
  </script>
</body>
</html>`;
}

// ==================== 常用部署页面 ====================
function getDashboardPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>常用部署</title>
  <style>
    :root {
      --primary: #f38020; --primary-hover: #e06c11;
      --bg: #f0f2f5; --card-bg: #ffffff;
      --text: #333333; --text-light: #666666;
      --border: #e0e0e0; --shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; color: var(--text);
    }
    .container { width: 100%; max-width: 950px; }
    .card { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px; }
    h2 { font-size: 24px; font-weight: 700; margin-bottom: 24px; color: #222; text-align: center; }
    
    .account-item { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; overflow: hidden; background: #fff; }
    
    .account-header {
      background: #f7f8fa; padding: 16px 20px; cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      font-weight: 600; user-select: none; transition: background 0.2s;
    }
    .account-header:hover { background: #f0f2f5; }
    .account-header-left { display: flex; align-items: center; gap: 12px; }
    .account-header input[type="checkbox"] { cursor: pointer; transform: scale(1.2); }
    .account-name { font-size: 16px; font-weight: 700; }
    
    .project-list {
      display: none; 
      padding: 15px 20px; background: #fafbfc; border-top: 1px solid var(--border);
    }
    .project-list.active { display: block; }

    .project-columns { display: flex; gap: 15px; flex-wrap: wrap; margin-bottom: 15px; }
    .project-column { flex: 1; min-width: 320px; background: #fff; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .column-header { background: #f7f8fa; padding: 12px 15px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; border-bottom: 1px solid var(--border); transition: background 0.2s; }
    .column-header:hover { background: #f0f2f5; }
    .column-header input[type="checkbox"] { cursor: pointer; transform: scale(1.1); }
    .column-content { padding: 5px 15px 15px 15px; }

    .temp-deploy-block { background: #fdfdfd; border: 1px dashed #ccc; border-radius: 8px; padding: 12px 15px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .temp-deploy-block input[type="text"], .temp-deploy-block select { flex: 1; min-width: 90px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; outline: none; }
    .temp-deploy-block input[type="text"]:focus, .temp-deploy-block select:focus { border-color: var(--primary); }
    .temp-deploy-block select:disabled { background: #eeeeee; color: #999; cursor: not-allowed; }
    .temp-cb-wrap { display: flex; align-items: center; gap: 5px; font-weight: bold; cursor: pointer; white-space: nowrap; margin-right: 5px; user-select: none; }
    .temp-cb-wrap input[type="checkbox"] { cursor: pointer; transform: scale(1.1); }
    
    .project-item { border-bottom: 1px solid #eee; padding: 10px 0; }
    .project-item:last-child { border-bottom: none; }
    .project-title { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
    .project-title input[type="checkbox"] { cursor: pointer; transform: scale(1.1); }
    .project-title .name { font-weight: 600; }
    .project-details { display: none; margin-top: 8px; padding-left: 30px; font-size: 13px; color: var(--text-light); }
    .project-details.active { display: block; }
    .detail-row { margin-bottom: 5px; }
    
    .deploy-btn {
      margin-top: 20px; width: 100%; padding: 14px; background: var(--primary); color: #fff;
      border: none; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; transition: 0.2s;
    }
    .deploy-btn:hover { background: var(--primary-hover); }
    .deploy-btn:disabled { background: #ccc; cursor: not-allowed; }
    .output-box { margin-top: 24px; }
    textarea {
      width: 100%; height: 400px; background: #1e1e2e; color: #4af626;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; padding: 15px;
      border-radius: 8px; border: none; resize: vertical; outline: none;
    }
    .nav-links { text-align: center; margin-top: 24px; }
    .nav-links a { display: inline-block; margin: 5px; padding: 10px 20px; background: var(--primary); color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h2>📋 常用部署</h2>
      <div id="accountList"></div>
      <button id="btnDeploySelected" class="deploy-btn">一键部署所选项目</button>
      <div class="output-box">
        <label>状态日志</label>
        <textarea id="logOutput" readonly placeholder="部署日志将显示在这里..."></textarea>
      </div>
      <div class="nav-links">
        <a href="/accounts">👤 账户设置</a>
        <a href="/">🏠 返回主页</a>
        <a href="/logout" style="background: #e74c3c;">🚪 退出系统</a>
      </div>
    </div>
  </div>
  <script>
    let allAccounts = [];
    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) {
        allAccounts = data.accounts || [];
        renderAccounts();
      }
    }
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function renderAccounts() {
      const container = document.getElementById('accountList');
      container.innerHTML = '';
      
      let visibleCount = 0;
      
      allAccounts.forEach((account, accIndex) => {
        // 如果账户级设置为不显示，则直接跳过渲染该账户
        if (account.show === false) return;
        
        visibleCount++;

        // 过滤出设置为“显示”的项目
        const activeWorkers = account.workers ? account.workers.filter(w => w.show !== false) : [];
        const activePages = account.pages ? account.pages.filter(p => p.show !== false) : [];

        const accDiv = document.createElement('div');
        accDiv.className = 'account-item';
        
        accDiv.innerHTML = 
          '<div class="account-header" data-acc-index="' + accIndex + '">' +
            '<div class="account-header-left">' +
              '<input type="checkbox" class="account-checkbox" data-acc-index="' + accIndex + '">' +
              '<span class="account-name">' + escapeHtml(account.identifier) + '</span>' +
            '</div>' +
            '<span class="arrow">▶</span>' +
          '</div>' +
          '<div class="project-list">' +
            '<div class="project-columns">' +
              '<div class="project-column">' +
                '<div class="column-header" data-acc-index="' + accIndex + '" data-group="worker">' +
                  '<input type="checkbox" class="group-checkbox" data-acc-index="' + accIndex + '" data-group="worker"> 🚀 Workers' +
                '</div>' +
                '<div class="column-content">' + renderProjects(activeWorkers, 'worker', accIndex) + '</div>' +
              '</div>' +
              '<div class="project-column">' +
                '<div class="column-header" data-acc-index="' + accIndex + '" data-group="page">' +
                  '<input type="checkbox" class="group-checkbox" data-acc-index="' + accIndex + '" data-group="page"> 📄 Pages' +
                '</div>' +
                '<div class="column-content">' + renderProjects(activePages, 'page', accIndex) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="temp-deploy-block">' +
              '<label class="temp-cb-wrap">' +
                '<input type="checkbox" class="temp-checkbox" data-acc-index="' + accIndex + '"> 临时部署' +
              '</label>' +
              '<select class="temp-type" data-acc-index="' + accIndex + '" style="max-width:85px;">' +
                '<option value="worker">Worker</option>' +
                '<option value="page">Pages</option>' +
              '</select>' +
              '<input type="text" class="temp-name" data-acc-index="' + accIndex + '" placeholder="项目名">' +
              '<input type="text" class="temp-kv" data-acc-index="' + accIndex + '" placeholder="KV名(选填)">' +
              '<select class="temp-kv-action" data-acc-index="' + accIndex + '" disabled style="max-width:75px;">' +
                '<option value="keep">保留</option>' +
                '<option value="clear">清空</option>' +
              '</select>' +
              '<input type="text" class="temp-source" data-acc-index="' + accIndex + '" placeholder="源地址(选填)">' +
            '</div>' +
          '</div>';
        container.appendChild(accDiv);
      });
      
      if (visibleCount === 0) {
        container.innerHTML = '<p style="text-align:center; color:#666;">暂无需要显示的账户，请前往账户设置添加或开启显示。</p>';
        return;
      }

      // 绑定临时部署模块的 KV 输入事件以联动下拉框
      document.querySelectorAll('.temp-kv').forEach(input => {
        input.addEventListener('input', function() {
          const idx = this.dataset.accIndex;
          const sel = document.querySelector('.temp-kv-action[data-acc-index="' + idx + '"]');
          if (sel) sel.disabled = !this.value.trim();
        });
      });

      document.querySelectorAll('.account-header').forEach(header => {
        header.addEventListener('click', function(e) {
          if (e.target.tagName === 'INPUT') return; 
          const list = this.nextElementSibling;
          list.classList.toggle('active');
          const arrow = this.querySelector('.arrow');
          if (arrow) arrow.textContent = list.classList.contains('active') ? '▼' : '▶';
        });
      });

      document.querySelectorAll('.account-checkbox').forEach(cb => {
        cb.addEventListener('change', function() {
          const idx = this.dataset.accIndex;
          document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"]').forEach(pcb => pcb.checked = this.checked);
          document.querySelectorAll('.group-checkbox[data-acc-index="' + idx + '"]').forEach(gcb => gcb.checked = this.checked);
        });
      });

      document.querySelectorAll('.column-header').forEach(header => {
        header.addEventListener('click', function(e) {
          const cb = this.querySelector('.group-checkbox');
          if (e.target.tagName !== 'INPUT') { cb.checked = !cb.checked; }
          const idx = this.dataset.accIndex;
          const group = this.dataset.group;
          document.querySelectorAll('.normal-checkbox[data-acc-index="' + idx + '"][data-type="' + group + '"]').forEach(pcb => pcb.checked = cb.checked);
          checkAccountSync(idx);
        });
      });

      document.querySelectorAll('.normal-checkbox').forEach(cb => {
        cb.addEventListener('change', function() {
          const idx = this.dataset.accIndex;
          const type = this.dataset.type;
          checkGroupSync(idx, type);
          checkAccountSync(idx);
        });
      });

      document.querySelectorAll('.project-title').forEach(title => {
        title.addEventListener('click', function(e) {
          if (e.target.tagName === 'INPUT') return;
          this.nextElementSibling.classList.toggle('active');
        });
      });
      
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
      if (!projects || projects.length === 0) return '<div style="padding: 15px 0; color: #999; text-align: center; font-size: 13px;">无配置项</div>';
      return projects.map(proj => {
        const icon = type === 'worker' ? '🚀' : '📄';
        // 渲染时展示相应的KV操作策略
        const kvDisp = proj.kvName ? proj.kvName + ' (' + (proj.kvAction === 'clear' ? '清空' : '保留') + ')' : '(留空/保留原绑定)';
        return '<div class="project-item">' +
          '<div class="project-title">' +
          '<input type="checkbox" class="project-checkbox normal-checkbox" data-acc-index="' + accIndex + '" data-type="' + type + '" data-name="' + escapeHtml(proj.name) + '">' +
          '<span class="name">' + icon + ' ' + escapeHtml(proj.name) + '</span></div>' +
          '<div class="project-details">' +
          '<div class="detail-row"><span>KV 名称：</span>' + escapeHtml(kvDisp) + '</div>' +
          '<div class="detail-row"><span>代码源：</span>' + escapeHtml(proj.codeUrl || '(默认)') + '</div>' +
          '</div></div>';
      }).join('');
    }

    document.getElementById('btnDeploySelected').addEventListener('click', async function() {
      const btn = this;
      const output = document.getElementById('logOutput');
      const selected = [];
      
      document.querySelectorAll('.normal-checkbox:checked, .temp-checkbox:checked').forEach(cb => {
        const accIndex = parseInt(cb.dataset.accIndex);
        const account = allAccounts[accIndex];
        
        if (cb.classList.contains('temp-checkbox')) {
          const type = document.querySelector('.temp-type[data-acc-index="' + accIndex + '"]').value;
          const name = document.querySelector('.temp-name[data-acc-index="' + accIndex + '"]').value.trim();
          const kvName = document.querySelector('.temp-kv[data-acc-index="' + accIndex + '"]').value.trim();
          const kvAction = document.querySelector('.temp-kv-action[data-acc-index="' + accIndex + '"]').value;
          const codeUrl = document.querySelector('.temp-source[data-acc-index="' + accIndex + '"]').value.trim();
          
          if (name) { 
             selected.push({ type, account, proj: { name, kvName, kvAction, codeUrl: codeUrl || 'default' } });
          }
        } else {
          const type = cb.dataset.type;
          const name = cb.dataset.name;
          const proj = type === 'worker' ? account.workers.find(w => w.name === name) : account.pages.find(p => p.name === name);
          if (proj) selected.push({ type, account, proj });
        }
      });

      if (selected.length === 0) return alert('请先勾选需要部署的项目 (若为临时部署，请确保填写了项目名)');
      
      btn.disabled = true;
      output.value = '开始部署 ' + selected.length + ' 个项目...\\n';
      output.scrollTop = output.scrollHeight;

      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        output.value += '\\n========== ' + (i+1) + '/' + selected.length + ' ==========\\n';
        output.value += '账号: ' + item.account.identifier + '\\n';
        output.value += '类型: ' + (item.type === 'worker' ? 'Worker' : 'Pages') + '\\n';
        output.value += '项目: ' + item.proj.name + '\\n';
        output.scrollTop = output.scrollHeight;

        const payload = { type: item.type, id: item.account.accountId, token: item.account.token, kv: item.proj.kvName || '', kvAction: item.proj.kvAction || 'keep', name: item.proj.name, source: item.proj.codeUrl || 'default' };
        
        try {
          const res = await fetch('/api/deploy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          const data = await res.json();
          output.value += (data.logs || []).join('\\n') + '\\n';
          output.scrollTop = output.scrollHeight;
        } catch (e) {
          output.value += '[错误] ' + e.message + '\\n';
          output.scrollTop = output.scrollHeight;
        }
      }
      output.value += '\\n========== 部署结束 ==========\\n';
      output.scrollTop = output.scrollHeight;
      btn.disabled = false;
    });

    loadAccounts();
  </script>
</body>
</html>`;
}

// ==================== 账户管理页面 ====================
function getAccountsPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>账户设置</title>
  <style>
    :root {
      --primary: #f38020; --primary-hover: #e06c11;
      --bg: #f0f2f5; --card-bg: #ffffff;
      --text: #333333; --text-light: #666666;
      --border: #e0e0e0; --shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; color: var(--text);
    }
    .container { width: 100%; max-width: 1000px; }
    .card { background: var(--card-bg); border-radius: var(--radius); box-shadow: var(--shadow); padding: 30px; }
    h2 { font-size: 24px; font-weight: 700; margin-bottom: 24px; color: #222; text-align: center; }
    
    .action-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .action-bar .btn { flex: 1; min-width: 120px; padding: 12px; font-size: 14px; display: flex; justify-content: center; align-items: center; gap: 5px;}
    .bg-green { background: #27ae60 !important; } .bg-green:hover { background: #2ecc71 !important; }
    .bg-orange { background: #f39c12 !important; } .bg-orange:hover { background: #f1c40f !important; }
    .bg-purple { background: #8e44ad !important; } .bg-purple:hover { background: #9b59b6 !important; }
    .bg-blue { background: #2980b9 !important; } .bg-blue:hover { background: #3498db !important; }

    .account-item { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; overflow: hidden; background: #fff; }
    .account-header { 
      background: #f7f8fa; padding: 16px 20px; cursor: pointer; 
      display: flex; justify-content: space-between; align-items: center; 
      transition: background 0.2s; user-select: none;
    }
    .account-header:hover { background: #f0f2f5; }
    
    .account-header-left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .account-header-left h3 { font-size: 18px; font-weight: 700; margin: 0; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .account-header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    
    .project-list { display: none; padding: 20px; border-top: 1px solid var(--border); background: #fafbfc; }
    .project-list.active { display: block; }
    
    .project-detail { background: #fff; border: 1px solid #eee; padding: 10px 12px; margin: 5px 0; border-radius: 6px; font-size: 13px; color: var(--text-light); display: flex; justify-content: space-between; align-items: center; }
    .project-detail-info { flex: 1; min-width: 0; word-break: break-all; overflow-wrap: break-word; }
    .project-detail-actions { display: flex; gap: 5px; margin-left: 10px; flex-shrink: 0; }

    .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.2s; color: #fff;}
    .btn-primary { background: var(--primary); } .btn-primary:hover { background: var(--primary-hover); }
    .btn-danger { background: #e74c3c; } .btn-danger:hover { background: #c0392b; }
    .btn-sm { padding: 6px 10px; font-size: 13px; }
    .btn-icon { padding: 4px 8px; font-size: 14px; font-weight: bold; background: #7f8c8d; } .btn-icon:hover { background: #95a5a6; }
    
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
    .modal.active { display: flex; }
    .modal-content { background: #fff; padding: 25px; border-radius: 12px; max-width: 900px; width: 95%; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow); }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; color: var(--text-light); }
    input[type="text"], input[type="password"], select { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; outline: none; }
    input[type="text"]:focus, input[type="password"]:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(243,128,32,0.15); }
    select:disabled { background: #f5f5f5; color: #a0a0a0; cursor: not-allowed; }
    
    .dynamic-list { margin-top: 10px; }
    .dynamic-item { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
    .dynamic-item input[type="text"] { flex: 2; min-width: 120px; }
    .remove-btn { background: #e74c3c; color: #fff; border: none; border-radius: 6px; padding: 6px 10px; font-size: 14px; cursor: pointer; }
    .add-btn { background: #3498db; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; margin-top: 5px; }
    .nav-links { text-align: center; margin-top: 24px; }
    .nav-links a { display: inline-block; margin: 5px; padding: 10px 20px; background: var(--primary); color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h2>👤 账户与数据管理</h2>
      
      <div class="action-bar">
        <button id="btnBackup" class="btn bg-green">💾 备份账户</button>
        <button id="btnShowRestore" class="btn bg-orange">⏪ 恢复备份</button>
        <button id="btnExport" class="btn bg-purple">📤 导出全部</button>
        <button id="btnImport" class="btn bg-blue">📥 导入恢复</button>
        <input type="file" id="importFile" style="display:none" accept=".json">
      </div>

      <div id="accountList"></div>
      <button id="btnAdd" class="btn btn-primary" style="width:100%; padding:14px; font-size: 16px;">➕ 添加新账户</button>
      
      <div class="nav-links">
        <a href="/dashboard">📋 返回常用部署</a>
        <a href="/">🏠 返回主页</a>
        <a href="/logout" style="background: #e74c3c;">🚪 退出系统</a>
      </div>
    </div>
  </div>

  <div id="editModal" class="modal">
    <div class="modal-content">
      <h3 id="modalTitle" style="margin-bottom:20px;">添加账户</h3>
      <div class="form-group"><label>标识 (唯一名称)</label><input type="text" id="editIdentifier"></div>
      <div class="form-group"><label>Account ID</label><input type="text" id="editAccountId"></div>
      <div class="form-group"><label>API Token</label><input type="password" id="editToken"></div>
      
      <div class="form-group">
        <label style="display:flex; align-items:center; gap:5px; cursor:pointer; user-select:none; font-size:14px; color:#333;">
          <input type="checkbox" id="editAccountShow" style="width:auto;" checked>
          在常用部署页面显示此账户
        </label>
      </div>
      
      <div class="form-group"><label>Workers</label><div id="workerList" class="dynamic-list"></div><button id="btnAddWorker" class="add-btn">添加 Worker</button></div>
      <div class="form-group"><label>Pages</label><div id="pagesList" class="dynamic-list"></div><button id="btnAddPage" class="add-btn">添加 Pages</button></div>
      <div style="display:flex; gap:10px; margin-top:20px;">
        <button id="btnSave" class="btn btn-primary" style="flex:1; padding:12px;">保存</button>
        <button id="btnCancel" class="btn btn-danger" style="flex:1; padding:12px;">取消</button>
      </div>
    </div>
  </div>

  <div id="restoreModal" class="modal">
    <div class="modal-content">
      <h3 style="margin-bottom:20px;">⏪ 选择备份进行恢复</h3>
      <div class="form-group">
        <label>在 KV 中找到的备份</label>
        <select id="backupSelect"></select>
        <small style="color: #666; display: block; margin-top: 10px;">注意：恢复操作会覆盖您当前的全部账户配置。</small>
      </div>
      <div style="display:flex; gap:10px; margin-top:20px;">
        <button id="btnConfirmRestore" class="btn bg-orange" style="flex:1;">确认恢复</button>
        <button id="btnCancelRestore" class="btn btn-danger" style="flex:1;">取消</button>
      </div>
    </div>
  </div>

  <script>
    let accounts = [];
    let editingIdentifier = null;

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.success) { accounts = data.accounts || []; renderAccounts(); }
    }
    
    async function saveAccountsOrder() {
      await fetch('/api/accounts/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts })
      });
      renderAccounts();
    }

    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    
    function moveAccount(index, direction) {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= accounts.length) return;
      const temp = accounts[index];
      accounts[index] = accounts[targetIndex];
      accounts[targetIndex] = temp;
      saveAccountsOrder();
    }

    function moveProject(accIndex, type, projIndex, direction) {
      const list = accounts[accIndex][type];
      if (!list) return;
      const targetIndex = projIndex + direction;
      if (targetIndex < 0 || targetIndex >= list.length) return;
      const temp = list[projIndex];
      list[projIndex] = list[targetIndex];
      list[targetIndex] = temp;
      saveAccountsOrder();
    }

    function moveModalRow(containerId, btn, direction) {
      const item = btn.closest('.dynamic-item');
      if (direction === -1 && item.previousElementSibling) {
        item.parentNode.insertBefore(item, item.previousElementSibling);
      } else if (direction === 1 && item.nextElementSibling) {
        item.parentNode.insertBefore(item.nextElementSibling, item);
      }
    }

    function renderAccounts() {
      const container = document.getElementById('accountList');
      container.innerHTML = '';
      if (accounts.length === 0) { container.innerHTML = '<p style="text-align:center; color:#666; margin-bottom: 20px;">暂无账户配置，请添加或导入。</p>'; return; }
      
      accounts.forEach((account, accIdx) => {
        const div = document.createElement('div'); div.className = 'account-item';
        
        const accShowTag = account.show !== false ? '' : ' <span style="color:#e74c3c; font-size:14px; font-weight:normal;">[已隐藏]</span>';

        const moveUpDisabled = accIdx === 0 ? 'disabled style="opacity:0.4;cursor:default;"' : '';
        const moveDownDisabled = accIdx === accounts.length - 1 ? 'disabled style="opacity:0.4;cursor:default;"' : '';

        div.innerHTML = '<div class="account-header">' +
          '<div class="account-header-left">' +
            '<h3>' + escapeHtml(account.identifier) + accShowTag + '</h3>' +
          '</div>' +
          '<div class="account-header-right">' +
            '<button class="btn btn-icon move-acc-up" ' + moveUpDisabled + ' data-idx="' + accIdx + '" title="上移">↑</button>' +
            '<button class="btn btn-icon move-acc-down" ' + moveDownDisabled + ' data-idx="' + accIdx + '" title="下移">↓</button>' +
            '<button class="btn btn-sm btn-primary edit-btn" data-identifier="' + escapeHtml(account.identifier) + '" title="编辑">✏️</button> ' +
            '<button class="btn btn-sm btn-danger delete-btn" data-identifier="' + escapeHtml(account.identifier) + '" title="删除">🗑️</button>' +
          '</div></div>' +
          
          '<div class="project-list">' +
            '<p style="font-weight:600; color: #333;">🚀 Workers:</p>' +
            (account.workers && account.workers.length > 0 
              ? account.workers.map((w, wIdx) => {
                  const showStr = w.show !== false ? '<span style="color:green;">[已显示]</span>' : '<span style="color:red;">[已隐藏]</span>';
                  const actionStr = w.kvName ? ' | KV操作: ' + (w.kvAction === 'clear' ? '清空' : '保留') : '';
                  const upDis = wIdx === 0 ? 'disabled style="opacity:0.4;cursor:default;"' : '';
                  const downDis = wIdx === account.workers.length - 1 ? 'disabled style="opacity:0.4;cursor:default;"' : '';
                  return '<div class="project-detail">' +
                    '<div class="project-detail-info"><b>' + escapeHtml(w.name) + '</b> ' + showStr + '<br><span style="color:#888;">KV: ' + escapeHtml(w.kvName || '无') + actionStr + ' | 源: ' + escapeHtml(w.codeUrl || '默认') + '</span></div>' +
                    '<div class="project-detail-actions">' +
                      '<button class="btn btn-icon move-proj-up" ' + upDis + ' data-acc="' + accIdx + '" data-type="workers" data-idx="' + wIdx + '" title="上移">↑</button>' +
                      '<button class="btn btn-icon move-proj-down" ' + downDis + ' data-acc="' + accIdx + '" data-type="workers" data-idx="' + wIdx + '" title="下移">↓</button>' +
                    '</div>' +
                  '</div>';
              }).join('') 
              : '<div class="project-detail" style="color:#aaa;">无配置</div>') +
            
            '<p style="font-weight:600; color: #333; margin-top:15px;">📄 Pages:</p>' +
            (account.pages && account.pages.length > 0 
              ? account.pages.map((p, pIdx) => {
                  const showStr = p.show !== false ? '<span style="color:green;">[已显示]</span>' : '<span style="color:red;">[已隐藏]</span>';
                  const actionStr = p.kvName ? ' | KV操作: ' + (p.kvAction === 'clear' ? '清空' : '保留') : '';
                  const upDis = pIdx === 0 ? 'disabled style="opacity:0.4;cursor:default;"' : '';
                  const downDis = pIdx === account.pages.length - 1 ? 'disabled style="opacity:0.4;cursor:default;"' : '';
                  return '<div class="project-detail">' +
                    '<div class="project-detail-info"><b>' + escapeHtml(p.name) + '</b> ' + showStr + '<br><span style="color:#888;">KV: ' + escapeHtml(p.kvName || '无') + actionStr + ' | 源: ' + escapeHtml(p.codeUrl || '默认') + '</span></div>' +
                    '<div class="project-detail-actions">' +
                      '<button class="btn btn-icon move-proj-up" ' + upDis + ' data-acc="' + accIdx + '" data-type="pages" data-idx="' + pIdx + '" title="上移">↑</button>' +
                      '<button class="btn btn-icon move-proj-down" ' + downDis + ' data-acc="' + accIdx + '" data-type="pages" data-idx="' + pIdx + '" title="下移">↓</button>' +
                    '</div>' +
                  '</div>';
              }).join('')
              : '<div class="project-detail" style="color:#aaa;">无配置</div>') +
          '</div>';
        
        container.appendChild(div);
      });

      document.querySelectorAll('.account-header').forEach(header => {
        header.addEventListener('click', function(e) {
          if (e.target.tagName === 'BUTTON') return;
          const list = this.nextElementSibling;
          list.classList.toggle('active');
        });
      });

      document.querySelectorAll('.move-acc-up').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); moveAccount(parseInt(btn.dataset.idx), -1); }));
      document.querySelectorAll('.move-acc-down').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); moveAccount(parseInt(btn.dataset.idx), 1); }));
      
      document.querySelectorAll('.move-proj-up').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); moveProject(parseInt(btn.dataset.acc), btn.dataset.type, parseInt(btn.dataset.idx), -1); }));
      document.querySelectorAll('.move-proj-down').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); moveProject(parseInt(btn.dataset.acc), btn.dataset.type, parseInt(btn.dataset.idx), 1); }));

      document.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', function() { openEdit(this.dataset.identifier); }));
      document.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', async function() {
        if (confirm('确定删除账户 ' + this.dataset.identifier + ' 吗？')) {
          await fetch('/api/accounts?identifier=' + encodeURIComponent(this.dataset.identifier), { method: 'DELETE' }); loadAccounts();
        }
      }));
    }

    document.getElementById('btnBackup').addEventListener('click', async () => {
      if(!confirm('是否将当前所有账户信息备份到 KV 数据库？')) return;
      const res = await fetch('/api/accounts/backup', { method: 'POST' });
      const data = await res.json();
      if(data.success) alert('✅ 备份成功！\\n备份文件名: ' + data.key);
      else alert('❌ 备份失败: ' + data.error);
    });

    document.getElementById('btnExport').addEventListener('click', () => { window.location.href = '/api/accounts/export'; });

    document.getElementById('btnShowRestore').addEventListener('click', async () => {
      const res = await fetch('/api/accounts/backup');
      const data = await res.json();
      if(!data.success) return alert('获取备份列表失败');
      
      const select = document.getElementById('backupSelect');
      select.innerHTML = '';
      if(data.backups.length === 0) return alert('在 KV 中未找到任何备份文件');
      
      data.backups.sort().reverse().forEach(b => {
        const opt = document.createElement('option');
        opt.value = b; opt.textContent = b;
        select.appendChild(opt);
      });
      document.getElementById('restoreModal').classList.add('active');
    });

    document.getElementById('btnConfirmRestore').addEventListener('click', async () => {
      const key = document.getElementById('backupSelect').value;
      if(!key) return;
      if(!confirm('⚠️ 警告：恢复操作将用备份文件覆盖当前的所有账户信息！\\n确认继续吗？')) return;
      
      const res = await fetch('/api/accounts/restore', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key })
      });
      const data = await res.json();
      if(data.success) {
        alert('✅ 恢复成功！'); document.getElementById('restoreModal').classList.remove('active'); loadAccounts();
      } else { alert('❌ 恢复失败: ' + data.error); }
    });
    
    document.getElementById('btnCancelRestore').addEventListener('click', () => document.getElementById('restoreModal').classList.remove('active'));

    document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', function() {
      const file = this.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = async function(e) {
        try {
          const json = JSON.parse(e.target.result);
          if(!confirm('⚠️ 警告：导入的文件将完全覆盖或新增到当前的 KV 数据库中。\\n确认导入吗？')) {
             document.getElementById('importFile').value = ''; return;
          }
          const res = await fetch('/api/accounts/import', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(json) });
          const data = await res.json();
          if(data.success) { alert('✅ 数据导入成功！'); loadAccounts(); } else { alert('❌ 导入失败: ' + data.error); }
        } catch(err) { alert('❌ 解析文件失败: 请确保上传的是合法的 JSON 格式备份文件。'); }
        document.getElementById('importFile').value = '';
      };
      reader.readAsText(file);
    });

    function openAdd() {
      editingIdentifier = null; document.getElementById('modalTitle').textContent = '添加账户';
      document.getElementById('editIdentifier').value = ''; document.getElementById('editAccountId').value = ''; document.getElementById('editToken').value = '';
      document.getElementById('editAccountShow').checked = true;
      document.getElementById('workerList').innerHTML = ''; document.getElementById('pagesList').innerHTML = '';
      document.getElementById('editModal').classList.add('active');
    }
    
    function openEdit(identifier) {
      const account = accounts.find(a => a.identifier === identifier);
      if (!account) return;
      editingIdentifier = identifier; document.getElementById('modalTitle').textContent = '编辑账户: ' + identifier;
      document.getElementById('editIdentifier').value = account.identifier; document.getElementById('editAccountId').value = account.accountId; document.getElementById('editToken').value = account.token;
      
      document.getElementById('editAccountShow').checked = account.show !== false;
      
      const wl = document.getElementById('workerList'); wl.innerHTML = ''; (account.workers || []).forEach(w => addWorkerRow(w.name, w.kvName, w.codeUrl, w.kvAction, w.show));
      const pl = document.getElementById('pagesList'); pl.innerHTML = ''; (account.pages || []).forEach(p => addPageRow(p.name, p.kvName, p.codeUrl, p.kvAction, p.show));
      document.getElementById('editModal').classList.add('active');
    }
    
    function addWorkerRow(name='', kvName='', codeUrl='', kvAction='keep', show=true) {
      const div = document.createElement('div'); div.className = 'dynamic-item';
      const kvDisabled = !kvName ? 'disabled' : '';
      const checked = show !== false ? 'checked' : '';
      div.innerHTML = '<input type="text" class="worker-name" placeholder="名称" value="' + escapeHtml(name) + '">' +
        '<input type="text" class="worker-kv" placeholder="KV 名称" value="' + escapeHtml(kvName) + '">' +
        '<select class="worker-kv-action" style="flex:1; min-width:80px;" ' + kvDisabled + '>' +
          '<option value="keep" ' + (kvAction==='keep'?'selected':'') + '>保留</option>' +
          '<option value="clear" ' + (kvAction==='clear'?'selected':'') + '>清空</option>' +
        '</select>' +
        '<input type="text" class="worker-url" placeholder="代码地址" value="' + escapeHtml(codeUrl) + '">' +
        '<label style="display:flex; align-items:center; gap:5px; margin:0; cursor:pointer; white-space:nowrap;"><input type="checkbox" class="worker-show" ' + checked + ' style="width:auto;"> 显示</label>' +
        '<button class="btn btn-icon row-up-btn" title="上移">↑</button>' +
        '<button class="btn btn-icon row-down-btn" title="下移">↓</button>' +
        '<button class="remove-btn" title="删除">🗑️</button>';
      
      const kvInput = div.querySelector('.worker-kv');
      const actionSelect = div.querySelector('.worker-kv-action');
      kvInput.addEventListener('input', () => { actionSelect.disabled = !kvInput.value.trim(); });
      div.querySelector('.row-up-btn').addEventListener('click', function() { moveModalRow('workerList', this, -1); });
      div.querySelector('.row-down-btn').addEventListener('click', function() { moveModalRow('workerList', this, 1); });
      div.querySelector('.remove-btn').addEventListener('click', () => div.remove());
      document.getElementById('workerList').appendChild(div);
    }
    
    function addPageRow(name='', kvName='', codeUrl='', kvAction='keep', show=true) {
      const div = document.createElement('div'); div.className = 'dynamic-item';
      const kvDisabled = !kvName ? 'disabled' : '';
      const checked = show !== false ? 'checked' : '';
      div.innerHTML = '<input type="text" class="page-name" placeholder="名称" value="' + escapeHtml(name) + '">' +
        '<input type="text" class="page-kv" placeholder="KV 名称" value="' + escapeHtml(kvName) + '">' +
        '<select class="page-kv-action" style="flex:1; min-width:80px;" ' + kvDisabled + '>' +
          '<option value="keep" ' + (kvAction==='keep'?'selected':'') + '>保留</option>' +
          '<option value="clear" ' + (kvAction==='clear'?'selected':'') + '>清空</option>' +
        '</select>' +
        '<input type="text" class="page-url" placeholder="ZIP 地址" value="' + escapeHtml(codeUrl) + '">' +
        '<label style="display:flex; align-items:center; gap:5px; margin:0; cursor:pointer; white-space:nowrap;"><input type="checkbox" class="page-show" ' + checked + ' style="width:auto;"> 显示</label>' +
        '<button class="btn btn-icon row-up-btn" title="上移">↑</button>' +
        '<button class="btn btn-icon row-down-btn" title="下移">↓</button>' +
        '<button class="remove-btn" title="删除">🗑️</button>';
      
      const kvInput = div.querySelector('.page-kv');
      const actionSelect = div.querySelector('.page-kv-action');
      kvInput.addEventListener('input', () => { actionSelect.disabled = !kvInput.value.trim(); });
      div.querySelector('.row-up-btn').addEventListener('click', function() { moveModalRow('pagesList', this, -1); });
      div.querySelector('.row-down-btn').addEventListener('click', function() { moveModalRow('pagesList', this, 1); });
      div.querySelector('.remove-btn').addEventListener('click', () => div.remove());
      document.getElementById('pagesList').appendChild(div);
    }
    
    document.getElementById('btnAdd').addEventListener('click', openAdd);
    document.getElementById('btnAddWorker').addEventListener('click', () => addWorkerRow());
    document.getElementById('btnAddPage').addEventListener('click', () => addPageRow());
    document.getElementById('btnCancel').addEventListener('click', () => document.getElementById('editModal').classList.remove('active'));
    
    document.getElementById('btnSave').addEventListener('click', async () => {
      const identifier = document.getElementById('editIdentifier').value.trim();
      const accountId = document.getElementById('editAccountId').value.trim();
      const token = document.getElementById('editToken').value.trim();
      const show = document.getElementById('editAccountShow').checked;
      
      if (!identifier || !accountId || !token) return alert('必填项不能为空');
      
      const workers = []; document.querySelectorAll('#workerList .dynamic-item').forEach(item => {
        const name = item.querySelector('.worker-name').value.trim(), 
              kvName = item.querySelector('.worker-kv').value.trim(), 
              kvAction = item.querySelector('.worker-kv-action').value,
              codeUrl = item.querySelector('.worker-url').value.trim(),
              showFlag = item.querySelector('.worker-show').checked;
        if (name) workers.push({ name, kvName, kvAction, codeUrl, show: showFlag });
      });
      const pages = []; document.querySelectorAll('#pagesList .dynamic-item').forEach(item => {
        const name = item.querySelector('.page-name').value.trim(), 
              kvName = item.querySelector('.page-kv').value.trim(), 
              kvAction = item.querySelector('.page-kv-action').value,
              codeUrl = item.querySelector('.page-url').value.trim(),
              showFlag = item.querySelector('.page-show').checked;
        if (name) pages.push({ name, kvName, kvAction, codeUrl, show: showFlag });
      });
      
      const payload = { identifier, accountId, token, show, workers, pages };
      const res = await fetch('/api/accounts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await res.json();
      if (data.success) { document.getElementById('editModal').classList.remove('active'); loadAccounts(); } 
      else alert('保存失败: ' + data.error);
    });
    
    loadAccounts();
  </script>
</body>
</html>`;
}

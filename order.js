export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 鉴权逻辑：检查路径是否匹配管理面板的要求
    const adminPaths = [
      '/NicholasLai',
      '/226279dd-28b2-4b61-96be-a2a0b1afd522'
    ];
    if (env.ADMIN) {
      adminPaths.push(`/${env.ADMIN}`);
    }
    const isAdmin = adminPaths.includes(path);

    // ==========================================
    // 后端 API 路由处理
    // ==========================================
    if (path.startsWith('/api/')) {
      
      // 1. 新建预约
      if (method === 'POST' && path === '/api/reservation') {
        const data = await request.json();
        const id = crypto.randomUUID();
        data.id = id;
        data.status = '待办';
        data.createdAt = Date.now();
        
        // 存入 KV 数据库，键名加上 'res:' 前缀以便于列表查询
        await env.KV.put(`res:${id}`, JSON.stringify(data));
        return new Response(JSON.stringify({ success: true, id }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 2. 获取“我的预约”列表 (通过客户端提交的 ID 列表进行查询)
      if (method === 'POST' && path === '/api/my-reservations') {
        const { ids } = await request.json();
        const results = [];
        for (let id of ids) {
          const val = await env.KV.get(`res:${id}`, 'json');
          if (val) results.push(val);
        }
        results.sort((a, b) => b.createdAt - a.createdAt);
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 3. 删除预约 (供用户在“我的预约”中调用)
      if (method === 'DELETE' && path.startsWith('/api/reservation/')) {
        const id = path.split('/').pop();
        await env.KV.delete(`res:${id}`);
        return new Response(JSON.stringify({ success: true }));
      }

      // 4. 管理员 API - 仅在管理员路径或具有权限时应被调用
      // 获取所有预约记录
      if (method === 'GET' && path === '/api/admin/reservations') {
        const list = await env.KV.list({ prefix: 'res:' });
        const results = [];
        for (let key of list.keys) {
          const val = await env.KV.get(key.name, 'json');
          if (val) results.push(val);
        }
        results.sort((a, b) => b.createdAt - a.createdAt);
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 修改预约状态/改期
      if (method === 'PUT' && path.startsWith('/api/reservation/')) {
        const id = path.split('/').pop();
        const updateData = await request.json();
        const val = await env.KV.get(`res:${id}`, 'json');
        if (val) {
          const newData = { ...val, ...updateData };
          await env.KV.put(`res:${id}`, JSON.stringify(newData));
          return new Response(JSON.stringify({ success: true }));
        }
        return new Response('Not found', { status: 404 });
      }

      return new Response('API Not Found', { status: 404 });
    }

    // ==========================================
    // 前端 HTML / CSS / JS 渲染
    // ==========================================
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>醉月楼预约系统</title>
    <style>
        :root { --primary: #4f46e5; --primary-hover: #4338ca; --bg: #f3f4f6; --card: #ffffff; }
        body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #1f2937; }
        .container { max-width: 600px; margin: 0 auto; background: var(--card); padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        h1 { text-align: center; color: #111827; margin-bottom: 24px; }
        
        /* Tabs */
        .tabs { display: flex; border-bottom: 2px solid #e5e7eb; margin-bottom: 20px; }
        .tab { flex: 1; text-align: center; padding: 12px; cursor: pointer; color: #6b7280; font-weight: 500; transition: 0.2s; }
        .tab:hover { color: #374151; }
        .tab.active { color: var(--primary); border-bottom: 2px solid var(--primary); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        /* Forms */
        .form-group { margin-bottom: 16px; }
        label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 14px; }
        input, select { width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
        input:focus, select:focus { outline: none; border-color: var(--primary); ring: 2px var(--primary); }
        
        /* Buttons */
        button { background: var(--primary); color: white; border: none; padding: 12px 16px; border-radius: 6px; cursor: pointer; width: 100%; font-size: 16px; font-weight: 500; transition: 0.2s; }
        button:hover { background: var(--primary-hover); }
        .btn-secondary { background: #e5e7eb; color: #374151; margin-top: 10px; }
        .btn-secondary:hover { background: #d1d5db; }
        .btn-success { background: #10b981; color: white; width: auto; flex: 1; }
        .btn-danger { background: #ef4444; color: white; width: auto; flex: 1; }
        .btn-warning { background: #f59e0b; color: white; width: auto; flex: 1; }
        .btn-icon { background: transparent; color: #ef4444; width: auto; padding: 8px; margin: 0; }
        .btn-icon:hover { background: #fee2e2; }
        
        /* Cards */
        .card { border: 1px solid #e5e7eb; padding: 16px; border-radius: 8px; margin-bottom: 12px; background: #f9fafb; position: relative; }
        .card p { margin: 6px 0; font-size: 14px; }
        .card-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 8px; }
        
        /* Status Badges */
        .badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; color: white; }
        .bg-pending { background: #f59e0b; }
        .bg-agreed { background: #10b981; }
        .bg-rejected { background: #ef4444; }
        
        .actions { display: flex; gap: 8px; margin-top: 12px; }
        .empty-state { text-align: center; color: #6b7280; padding: 20px 0; font-size: 14px; }
    </style>
</head>
<body>

<div class="container">
    <h1>醉月楼预约系统</h1>
    
    <div class="tabs">
        <div class="tab active" onclick="switchTab('new')">新建预约</div>
        <div class="tab" onclick="switchTab('my')">我的预约</div>
        <!-- 核心修复区：修复了 onclick 中转义单引号的问题 -->
        ${isAdmin ? '<div class="tab" onclick="switchTab(\'admin\')">管理预约</div>' : ''}
    </div>

    <!-- 填单区 -->
    <div id="tab-new" class="tab-content active">
        <form id="reservationForm" onsubmit="submitForm(event)">
            <div class="form-group">
                <label>日期</label>
                <input type="date" id="date" required>
            </div>
            <div class="form-group">
                <label>时段</label>
                <select id="timeSlot" required>
                    <option value="早餐">早餐</option>
                    <option value="午餐">午餐</option>
                    <option value="晚餐">晚餐</option>
                    <option value="宵夜">宵夜</option>
                    <option value="其它">其它</option>
                </select>
            </div>
            <div class="form-group">
                <label>受邀人</label>
                <input type="text" id="invitee" required placeholder="请输入受邀人姓名">
            </div>
            <div class="form-group">
                <label>邀请人</label>
                <input type="text" id="inviter" required placeholder="请输入邀请人姓名">
            </div>
            <div class="form-group">
                <label>邀请码</label>
                <input type="text" id="code" required placeholder="请输入邀请码">
            </div>
            <button type="submit">确认</button>
        </form>
    </div>

    <!-- 我的预约 -->
    <div id="tab-my" class="tab-content">
        <div id="myList"></div>
        <button class="btn-secondary" onclick="switchTab('new')">返回主页</button>
    </div>

    <!-- 管理预约 -->
    ${isAdmin ? `
    <div id="tab-admin" class="tab-content">
        <div id="adminList"></div>
        <div class="actions" style="margin-top:20px;">
            <button onclick="location.reload()">确定 (刷新本页)</button>
            <button class="btn-secondary" onclick="switchTab('new')">返回主页</button>
        </div>
    </div>
    ` : ''}
</div>

<script>
    const IS_ADMIN = ${isAdmin};
    
    // 垃圾桶图标 SVG
    const trashIcon = \`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>\`;

    // 切换选项卡
    function switchTab(tabId) {
        document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        
        // 匹配对应的 tab 按钮并高亮
        const tabs = document.querySelectorAll('.tab');
        if (tabId === 'new') tabs[0].classList.add('active');
        if (tabId === 'my') {
            tabs[1].classList.add('active');
            loadMyReservations();
        }
        if (tabId === 'admin' && IS_ADMIN) {
            tabs[2].classList.add('active');
            loadAdminReservations();
        }
        
        document.getElementById('tab-' + tabId).classList.add('active');
    }

    // 提交预约表单
    async function submitForm(e) {
        e.preventDefault();
        const data = {
            date: document.getElementById('date').value,
            timeSlot: document.getElementById('timeSlot').value,
            invitee: document.getElementById('invitee').value,
            inviter: document.getElementById('inviter').value,
            code: document.getElementById('code').value
        };

        const res = await fetch('/api/reservation', {
            method: 'POST',
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await res.json();
        if (result.success) {
            // 将生成的预约 ID 存入浏览器的 LocalStorage，用于关联“我的预约”
            let myIds = JSON.parse(localStorage.getItem('zuiyuelou_ids') || '[]');
            myIds.push(result.id);
            localStorage.setItem('zuiyuelou_ids', JSON.stringify(myIds));
            
            e.target.reset(); // 清空表单
            switchTab('my');  // 前往我的预约
        }
    }

    // 渲染状态徽章
    function getStatusBadge(status) {
        let colorClass = 'bg-pending';
        if (status === '已同意') colorClass = 'bg-agreed';
        if (status === '被拒') colorClass = 'bg-rejected';
        return \`<span class="badge \${colorClass}">\${status}</span>\`;
    }

    // 加载我的预约
    async function loadMyReservations() {
        const container = document.getElementById('myList');
        container.innerHTML = '<div class="empty-state">加载中...</div>';
        
        const myIds = JSON.parse(localStorage.getItem('zuiyuelou_ids') || '[]');
        if (myIds.length === 0) {
            container.innerHTML = '<div class="empty-state">暂无预约记录</div>';
            return;
        }

        const res = await fetch('/api/my-reservations', {
            method: 'POST',
            body: JSON.stringify({ ids: myIds }),
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        
        if (data.length === 0) {
            container.innerHTML = '<div class="empty-state">暂无预约记录</div>';
            return;
        }

        container.innerHTML = data.map(item => \`
            <div class="card">
                <div class="card-header">
                    <strong>\${item.date} (\${item.timeSlot})</strong>
                    \${getStatusBadge(item.status)}
                </div>
                <p><strong>受邀人:</strong> \${item.invitee}</p>
                <p><strong>邀请人:</strong> \${item.inviter}</p>
                <p><strong>邀请码:</strong> \${item.code}</p>
                <div class="actions" style="justify-content: flex-end;">
                    <button class="btn-icon" onclick="deleteMyReservation('\${item.id}')" title="删除">
                        \${trashIcon}
                    </button>
                </div>
            </div>
        \`).join('');
    }

    // 删除我的预约
    async function deleteMyReservation(id) {
        if (!confirm('确定要删除此预约吗？')) return;
        
        await fetch('/api/reservation/' + id, { method: 'DELETE' });
        
        // 从本地存储中移除
        let myIds = JSON.parse(localStorage.getItem('zuiyuelou_ids') || '[]');
        myIds = myIds.filter(myId => myId !== id);
        localStorage.setItem('zuiyuelou_ids', JSON.stringify(myIds));
        
        loadMyReservations(); // 刷新列表
    }

    // 加载管理预约 (仅管理员)
    async function loadAdminReservations() {
        if (!IS_ADMIN) return;
        const container = document.getElementById('adminList');
        container.innerHTML = '<div class="empty-state">加载中...</div>';

        const res = await fetch('/api/admin/reservations');
        const data = await res.json();
        
        if (data.length === 0) {
            container.innerHTML = '<div class="empty-state">暂无预约请求</div>';
            return;
        }

        container.innerHTML = data.map(item => \`
            <div class="card">
                <div class="card-header">
                    <strong>\${item.date} (\${item.timeSlot})</strong>
                    \${getStatusBadge(item.status)}
                </div>
                <p><strong>受邀人:</strong> \${item.invitee}</p>
                <p><strong>邀请人:</strong> \${item.inviter}</p>
                <p><strong>邀请码:</strong> \${item.code}</p>
                
                <div class="actions">
                    <button class="btn-success" onclick="updateStatus('\${item.id}', '已同意')">同意</button>
                    <button class="btn-danger" onclick="updateStatus('\${item.id}', '被拒')">拒绝</button>
                    <button class="btn-warning" onclick="reschedule('\${item.id}', '\${item.date}', '\${item.timeSlot}')">改期</button>
                </div>
            </div>
        \`).join('');
    }

    // 管理员：更新状态
    async function updateStatus(id, status) {
        await fetch('/api/reservation/' + id, {
            method: 'PUT',
            body: JSON.stringify({ status }),
            headers: { 'Content-Type': 'application/json' }
        });
        loadAdminReservations();
    }

    // 管理员：改期
    async function reschedule(id, oldDate, oldTimeSlot) {
        const input = prompt("请输入新的日期和时段 (格式：yyyy-mm-dd 时段):", \`\${oldDate} \${oldTimeSlot}\`);
        if (!input || input.trim() === '') return;
        
        const parts = input.trim().split(' ');
        const date = parts[0];
        const timeSlot = parts[1] || '其它';

        await fetch('/api/reservation/' + id, {
            method: 'PUT',
            body: JSON.stringify({ date, timeSlot }),
            headers: { 'Content-Type': 'application/json' }
        });
        loadAdminReservations();
    }
</script>
</body>
</html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

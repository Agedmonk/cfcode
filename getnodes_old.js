/**
 * 全球机房发布系统
 * 逻辑：
 * 1. 自动提取当前根域名 (Root Domain)。
 * 2. 匹配失败 -> 自动重定向到 https://www.当前根域名。
 * 3. 快捷键 (/ss) -> 自动补全为 /ss/当前根域名。
 */

const repositories_path = 'https://raw.githubusercontent.com/Agedmonk/team/refs/heads/main/'

const MAPPINGS = {
  // 板块1：基地连接
  'niclai': repositories_path + 'station-niclai.txt',
  'sihui': repositories_path + 'station-sihui.txt',
  'zhaoqing': repositories_path + 'station-zhaoqing.txt',
  'oracle': repositories_path + 'oracle.txt',
  'auto': repositories_path + 'auto.txt',
  'allnodes': repositories_path + 'allnodes.txt',

  // 板块2：影子连接 (SS)
  'ss/niclai.vip': 'https://ss.niclai.vip/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/sihui.city': 'https://ss.sihui.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/zhaoqing.city': 'https://ss.zhaoqing.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/zhaoqing.icu': 'https://ss.zhaoqing.icu/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/qingyuan.city': 'https://ss.qingyuan.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/qingyuan.icu': 'https://ss.qingyuan.icu/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',

  // 板块3：自由中国 (FreeChina)
  'freechina/niclai.vip': 'https://freechina.niclai.vip/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/sihui.city': 'https://freechina.sihui.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/zhaoqing.city': 'https://freechina.zhaoqing.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/zhaoqing.icu': 'https://freechina.zhaoqing.icu/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/qingyuan.city': 'https://freechina.qingyuan.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/qingyuan.icu': 'https://freechina.qingyuan.icu/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',

  // 板块4：实时连接 (BPB)
  'bpb/niclai.vip': 'https://yun.niclai.vip/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/sihui.city': 'https://yun.sihui.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/zhaoqing.city': 'https://yun.zhaoqing.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/zhaoqing.icu': 'https://yun.zhaoqing.icu/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/qingyuan.city': 'https://yun.qingyuan.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/qingyuan.icu': 'https://yun.qingyuan.icu/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    
    // 1. 动态提取根域名
    const hostParts = hostname.split('.');
    const rootDomain = hostParts.length > 2 ? hostParts.slice(-2).join('.') : hostname;
    const mainRedirectTarget = `https://www.${rootDomain}`;

    let key = url.pathname.replace(/^\/+|\/+$/g, '');

    // 2. 入口Token
    if (key === "Agedmonk" || key === "NicholasLai") {
      return new Response(getHtmlPage(hostname), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 3. 智能快捷补全 (动态使用 rootDomain)
    if (['ss', 'freechina', 'bpb'].includes(key)) {
      key = `${key}/${rootDomain}`;
    }

    // 4. 匹配校验与输出
    if (key in MAPPINGS) {
      try {
        const response = await fetch(MAPPINGS[key]);
        const text = await response.text();
        return new Response(text, {
          headers: { 
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (e) {
        return Response.redirect(mainRedirectTarget, 302);
      }
    }

    // 5. 最终防线：参数不正确直接甩到对应的主站 www
    return Response.redirect(mainRedirectTarget, 302);
  }
};

/** 经典 UI 保持不变 **/
function getHtmlPage(domain) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
    <title>全球机房 | ${domain}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: -apple-system, system-ui, sans-serif; background-color: #f4f4f4; text-align: center; margin: 0; padding: 20px 10px; }
        .container { max-width: 650px; margin: 0 auto; background: #fff; padding: 20px; box-shadow: 0px 4px 15px rgba(0,0,0,0.1); border-radius: 15px; }
        h2 { color: #333; }
        .group-container { border: 1px solid #eee; padding: 15px; margin-bottom: 20px; border-radius: 12px; background: #fff; }
        .group-title { font-size: 16px; font-weight: bold; color: #555; margin-bottom: 12px; display: flex; align-items: center; justify-content: center; }
        .group-title::before, .group-title::after { content: ""; flex: 1; height: 1px; background: #eee; margin: 0 10px; }
        .btn-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
        button { width: 30%; min-width: 90px; padding: 10px 5px; border: none; color: white; font-size: 12px; cursor: pointer; border-radius: 6px; }
        .green { background-color: #28a745; } .orange { background-color: #fd7e14; } .red { background-color: #dc3545; } .blue { background-color: #007bff; }
        .yellow { background-color: #e8a600; width: 85%; margin-top: 15px; font-weight: bold; }
        .output { background: #eee; color: #333; padding: 12px; margin-top: 15px; white-space: pre-wrap; word-wrap: break-word; min-height: 50px; border-radius: 5px; text-align: left; font-size: 13px; }
        #customAlert { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); padding: 12px 25px; border-radius: 30px; color: white; display: none; z-index: 1000; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
    </style>
</head>
<body>
    <div class="container">
        <h2>全球机房</h2>
        <div style="color: #888; margin-bottom: 20px;">正在访问: ${domain}</div>
        <div class="group-container"><div class="group-title">基地连接</div><div class="btn-grid">
            <button class="green" onclick="fetchData('/niclai')">个人机房</button>
			<button class="green" onclick="fetchData('/zhaoqing')">肇庆机房</button>
			<button class="green" onclick="fetchData('/oracle')">大阪机房</button>
			<button class="green" onclick="fetchData('/sihui')">四会机房</button>
			<button class="green" onclick="fetchData('/auto')">最新数据</button>
			<button class="green" onclick="fetchData('/allnodes')">全部机房</button>
        </div></div>
        <div class="group-container"><div class="group-title">影子连接</div><div class="btn-grid">
            <button class="orange" onclick="fetchData('/ss/niclai.vip')">个人机房</button>
			<button class="orange" onclick="fetchData('/ss/zhaoqing.city')">肇庆机房</button>
			<button class="orange" onclick="fetchData('/ss/qingyuan.city')">清远机房</button>
			<button class="orange" onclick="fetchData('/ss/sihui.city')">四会机房</button>
			<button class="orange" onclick="fetchData('/ss/zhaoqing.icu')">肇庆应急</button>
			<button class="orange" onclick="fetchData('/ss/qingyuan.icu')">清远应急</button>
        </div></div>
        <div class="group-container"><div class="group-title">自由中国</div><div class="btn-grid">
            <button class="red" onclick="fetchData('/freechina/niclai.vip')">个人机房</button>
			<button class="red" onclick="fetchData('/freechina/zhaoqing.city')">肇庆机房</button>
			<button class="red" onclick="fetchData('/freechina/qingyuan.city')">清远机房</button>
			<button class="red" onclick="fetchData('/freechina/sihui.city')">四会机房</button>
			<button class="red" onclick="fetchData('/freechina/zhaoqing.icu')">肇庆应急</button>
			<button class="red" onclick="fetchData('/freechina/qingyuan.icu')">清远应急</button>
        </div></div>
        <div class="group-container"><div class="group-title">实时连接</div><div class="btn-grid">
			<button class="blue" onclick="fetchData('/bpb/niclai.vip')">个人机房</button>
			<button class="blue" onclick="fetchData('/bpb/zhaoqing.city')">肇庆机房</button>
			<button class="blue" onclick="fetchData('/bpb/qingyuan.city')">清远机房</button>
			<button class="blue" onclick="fetchData('/bpb/sihui.city')">四会机房</button>
			<button class="blue" onclick="fetchData('/bpb/zhaoqing.icu')">肇庆应急</button>
			<button class="blue" onclick="fetchData('/bpb/qingyuan.icu')">清远应急</button>
        </div></div>
        <button class="yellow" onclick="copyText()">一键复制内容</button>
        <div class="output" id="output">选择节点获取代码...</div>
    </div>
    <div id="customAlert"></div>
    <script>
        async function fetchData(p) {
            const o = document.getElementById('output');
            o.textContent = "获取中...";
            try { const r = await fetch(p); o.textContent = await r.text(); }
            catch(e) { o.textContent = "获取失败"; }
        }
        function copyText() {
            const t = document.getElementById('output').textContent;
            if(!t || t.includes('获取中')) return;
            navigator.clipboard.writeText(t).then(() => {
                const a = document.getElementById('customAlert');
                a.textContent = "内容已复制"; a.style.background = "#28a745"; a.style.display = "block";
                setTimeout(() => a.style.display = "none", 2000);
            });
        }
    </script>
</body>
</html>`;
}

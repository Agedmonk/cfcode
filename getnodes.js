/**
 * 全球机房发布系统
 * 逻辑：
 * 1. 自动提取当前根域名 (Root Domain)。
 * 2. 匹配失败 -> 自动重定向到 https://www.当前根域名。
 * 3. 快捷键 (/ss) -> 自动补全为 /ss/当前根域名。
 * 4. 节点内容请求 -> 前端通过 /proxy?url= 代理获取，解决跨域。
 */

const repositories_path = 'https://raw.githubusercontent.com/Agedmonk/team/refs/heads/main/'

const MAPPINGS = {
  //板块1：日常连接 (Niclai)
  'home': 'https://home.qingyuan.city/sub?token=358d8b97e89b6219a60e384d31ccae9f', 
  'chinatelecom': 'https://chinatelecom.qingyuan.city/sub?token=fefd7730454a1d1bf4a89b3202de3c3d',
  'cmcc': 'https://cmcc.qingyuan.city/sub?token=df16f2c1fc47b0a4543b6c78cfe73224',
  'huahailink': 'https://huahailink.qingyuan.city/sub?token=5507dfd45861611c21c7a0a75d7eb6ec',
  'huahai': 'https://huahailink.qingyuan.city/sub?token=5507dfd45861611c21c7a0a75d7eb6ec',
  
  'niclai/home': 'https://home.qingyuan.city/sub?token=358d8b97e89b6219a60e384d31ccae9f', 
  'niclai/chinatelecom': 'https://chinatelecom.qingyuan.city/sub?token=fefd7730454a1d1bf4a89b3202de3c3d',
  'niclai/cmcc': 'https://cmcc.qingyuan.city/sub?token=df16f2c1fc47b0a4543b6c78cfe73224',
  'niclai/huahailink': 'https://huahailink.qingyuan.city/sub?token=5507dfd45861611c21c7a0a75d7eb6ec',
  'niclai/huahai': 'https://huahailink.qingyuan.city/sub?token=5507dfd45861611c21c7a0a75d7eb6ec',
  
  // 板块2：隧道连接 (EdgeTunnel)
  'edge/niclai.vip': 'https://edge.niclai.vip/sub?token=102b3972db4ebfa502ec57efdb326578',
  'edge/sihui.city': 'https://edge.sihui.city/sub?token=35e40796c83ae28dbd6ec9827d4a52b4',
  'edge/zhaoqing.city': 'https://edge.zhaoqing.city/sub?token=b1b55f4fcde165fc88d36126e72ef6f7',
  'edge/zhaoqing.icu': 'https://edge.zhaoqing.icu/sub?token=ee938efddaebde70ac91aea7e078cc12',
  'edge/qingyuan.city': 'https://edge.qingyuan.city/sub?token=30a0f2fb0782887ac7b619f64a595288',
  'edge/maoming.city': 'https://edge.maoming.city/sub?token=8ce078439673804c0da42bb56b6a03e3',
  
  // 板块3：影子连接 (SS)
  'ss/niclai.vip': 'https://ss.niclai.vip/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/sihui.city': 'https://ss.sihui.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/zhaoqing.city': 'https://ss.zhaoqing.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/zhaoqing.icu': 'https://ss.zhaoqing.icu/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/qingyuan.city': 'https://ss.qingyuan.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/maoming.city': 'https://ss.maoming.city/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',
  'ss/huahai.asia': 'https://ss.huahai.asia/sub/226279dd-28b2-4b61-96be-a2a0b1afd522',

  // 板块4：自由中国 (FreeChina)
  'freechina/niclai.vip': 'https://freechina.niclai.vip/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/sihui.city': 'https://freechina.sihui.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/zhaoqing.city': 'https://freechina.zhaoqing.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/zhaoqing.icu': 'https://freechina.zhaoqing.icu/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/qingyuan.city': 'https://freechina.qingyuan.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  'freechina/maoming.city': 'https://freechina.maoming.city/226279dd-28b2-4b61-96be-a2a0b1afd522/sub',
  
  // 板块5：实时连接 (BPB)
  'bpb/niclai.vip': 'https://yun.niclai.vip/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/sihui.city': 'https://yun.sihui.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/zhaoqing.city': 'https://yun.zhaoqing.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/zhaoqing.icu': 'https://yun.zhaoqing.icu/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/qingyuan.city': 'https://yun.qingyuan.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  'bpb/maoming.city': 'https://yun.maoming.city/sub/raw/226279dd-28b2-4b61-96be-a2a0b1afd522?app=xray#%F0%9F%92%A6%20BPB%20Raw',
  
  // 板块6：基地连接 (Station)
  'station/niclai': repositories_path + 'station-niclai.txt',
  'station/sihui': repositories_path + 'station-sihui.txt',
  'station/zhaoqing': repositories_path + 'station-zhaoqing.txt',
  'station/oracle': repositories_path + 'oracle.txt',
  'station/auto': repositories_path + 'auto.txt',
  'station/allnodes': repositories_path + 'allnodes.txt',
  'station/home': repositories_path + 'home.txt',
  'station/huahailink': repositories_path + 'huahailink.txt',
  'station/huahai': repositories_path + 'huahailink.txt',
  'station/chinatelecom': repositories_path + 'chinatelecom.txt',
  
      //板块7：清远机房
  'qingyuan.city/edge':"https://edge.qingyuan.city/sub?token=30a0f2fb0782887ac7b619f64a595288",
  'qingyuan.city/home':"https://home.qingyuan.city/sub?token=358d8b97e89b6219a60e384d31ccae9f",
  'qingyuan.city/huahailink':"https://huahailink.qingyuan.city/sub?token=5507dfd45861611c21c7a0a75d7eb6ec",
  'qingyuan.city/cmcc':"https://cmcc.qingyuan.city/sub?token=df16f2c1fc47b0a4543b6c78cfe73224",
  'qingyuan.city/chinatelecom':"https://chinatelecom.qingyuan.city/sub?token=fefd7730454a1d1bf4a89b3202de3c3d",
  
      //板块8：肇庆机房
  'zhaoqing.city/edge':"https://edge.zhaoqing.city/sub?token=b1b55f4fcde165fc88d36126e72ef6f7",
  'zhaoqing.city/home':"https://home.zhaoqing.city/sub?token=dc040ed728cfcb9a1218e96a4c056c61",
  'zhaoqing.city/huahailink':"https://huahailink.zhaoqing.city/sub?token=8ff6ee6dda08c73e1510457b87dbb6a9",
  'zhaoqing.city/cmcc':"https://cmcc.zhaoqing.city/sub?token=1d23946640d723cbee807ecfe3c83242",
  'zhaoqing.city/chinatelecom':"https://chinatelecom.zhaoqing.city/sub?token=daa40aa3126edab5d6284cbc8fd32e51",
  
    //板块9：茂名机房
  'maoming.city/edge':"https://edge.maoming.city/sub?token=8ce078439673804c0da42bb56b6a03e3",
  'maoming.city/home':"https://home.maoming.city/sub?token=79ad53b685529ce9732fbfcc0a276c6e",
  'maoming.city/huahailink':"https://huahailink.maoming.city/sub?token=bf6adacdacb030fc2e2f778cf45f5f5a",
  'maoming.city/cmcc':"https://cmcc.maoming.city/sub?token=a3be3e68caeb5a6f80b8b810a0660f30",
  'maoming.city/chinatelecom':"https://chinatelecom.maoming.city/sub?token=aa130b3d12258d7dadf628656ad044d0",
  
      //板块10：四会机房
  'sihui.city/edge':"https://edge.sihui.city/sub?token=35e40796c83ae28dbd6ec9827d4a52b4",
  'sihui.city/home':"https://home.sihui.city/sub?token=bee79c773aade4283bd402a6b846f043",
  'sihui.city/huahailink':"https://huahailink.sihui.city/sub?token=146251785688ba3cef4d1775979987f1",
  'sihui.city/cmcc':"https://cmcc.sihui.city/sub?token=a35ba7ca0468fe6e48f627e598297b32",
  'sihui.city/chinatelecom':"https://chinatelecom.sihui.city/sub?token=cb881b7611a5408a992dea3701e35a2c",
  
    //板块11：个人机房
  'niclai.vip/edge':"https://edge.niclai.vip/sub?token=102b3972db4ebfa502ec57efdb326578",
  'niclai.vip/home':"https://home.niclai.vip/sub?token=3fc946ba13c441bba4c07e33203519d0",
  'niclai.vip/huahailink':"https://huahailink.niclai.vip/sub?token=280d70f58143817b596526e30924f0b2",
  'niclai.vip/cmcc':"https://cmcc.niclai.vip/sub?token=a229289db582adb36dab8e214974cce4",
  'niclai.vip/chinatelecom':"https://chinatelecom.niclai.vip/sub?token=7fbd32f00f43200cf3f917f0fc1351ad",
  
    //板块12：华海机房
  'huahai.asia/edge':"https://edge.huahai.asia/sub?token=abd510540d7f4753e56a887ad3540851",
  'huahai.asia/home':"https://home.huahai.asia/sub?token=ffe7454856d58dfe34bfab356992ad6a",
  'huahai.asia/huahailink':"https://huahailink.huahai.asia/sub?token=bc3421f4a1149a9d1c318e502e0a0854",
  'huahai.asia/cmcc':"https://cmcc.huahai.asia/sub?token=ec9faf2534de435aaae491a6ec1b459a",
  'huahai.asia/chinatelecom':"https://chinatelecom.huahai.asia/sub?token=e96d6682cc858075daafd8515cf43eb8",
  
    //板块13：应急机房
  'zhaoqing.icu/edge':"https://edge.zhaoqing.icu/sub?token=ee938efddaebde70ac91aea7e078cc12",
  'zhaoqing.icu/home':"https://home.zhaoqing.icu/sub?token=60122d54cde6e9cbe6d4c623b59b6a80",
  'zhaoqing.icu/huahailink':"https://huahailink.zhaoqing.icu/sub?token=8d5e9f5d912c3d3204d69db700dda485",
  'zhaoqing.icu/cmcc':"https://cmcc.zhaoqing.icu/sub?token=7ee79d3c04a810906d06720c7f8f80af",
  'zhaoqing.icu/chinatelecom':"https://chinatelecom.zhaoqing.icu/sub?token=87f3c36958ffc55dd2fcd757613f33ce",
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

    // ---- 新增：CORS 代理端点 ----
    if (key === 'proxy') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response('Missing url parameter', { status: 400 });
      }

      // 简单的安全校验：只允许代理 MAPPINGS 中已配置的地址
      const allowedUrls = Object.values(MAPPINGS);
      if (!allowedUrls.includes(targetUrl)) {
        return new Response('Forbidden', { status: 403 });
      }

      try {
        const response = await fetch(targetUrl);
        const text = await response.text();
        return new Response(text, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",   // 关键：允许前端跨域读取
          }
        });
      } catch (e) {
        return new Response('Proxy error', { status: 502 });
      }
    }

    // 2. 入口Token
    if (key === "Agedmonk" || key === "NicholasLai") {
      return new Response(getHtmlPage(hostname, MAPPINGS), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 3. 智能快捷补全
    if (['niclai', 'edge', 'station', 'ss', 'freechina', 'bpb'].includes(key)) {
      key = `${key}/${rootDomain}`;
    }

    // 4. 匹配到节点：返回 302 重定向到真实地址（用于直接订阅）
    if (key in MAPPINGS) {
      return Response.redirect(MAPPINGS[key], 302);
    }

    // 5. 最终防线
    return Response.redirect(mainRedirectTarget, 302);
  }
};

function getHtmlPage(domain, mappings) {
  const mappingsJson = JSON.stringify(mappings);

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
        .green { background-color: #28a745; } .orange { background-color: #fd7e14; } .red { background-color: #dc3545; } .blue { background-color: #007bff; } .purple { background-color: #6f42c1; } .teal { background-color: #20c997; }
        .yellow { background-color: #e8a600; width: 85%; margin-top: 15px; font-weight: bold; }.indigo { background-color: #6610f2; }.slate { background-color: #495057; }.pink { background-color: #e83e8c; }
        .output { background: #eee; color: #333; padding: 12px; margin-top: 15px; white-space: pre-wrap; word-wrap: break-word; min-height: 50px; border-radius: 5px; text-align: left; font-size: 13px; }
        #customAlert { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); padding: 12px 25px; border-radius: 30px; color: white; display: none; z-index: 1000; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
        .linkUrl-box { background: #e9ecef; color: #495057; padding: 10px; margin-top: 10px; border-radius: 5px; font-size: 12px; width: 100%; word-break: break-all; text-align: left; }
    </style>
</head>
<body>
    <div class="container">
        <h2>全球机房</h2>
		
        <div style="color: #888; margin-bottom: 20px;">正在访问: ${domain}</div>
		
        <div class="group-container"><div class="group-title">日常连接</div><div class="btn-grid">         
          <button class="pink" onclick="fetchData('niclai/chinatelecom')">电信网络</button>
		  <button class="pink" onclick="fetchData('niclai/cmcc')">移动网络</button>
          <button class="pink" onclick="fetchData('niclai/huahailink')">工作网络</button>
		  <button class="pink" onclick="fetchData('niclai/home')">家庭网络</button>
		  <button class="pink" onclick="fetchData('/edge/maoming.city')">边缘网络</button>
		  <button class="pink" onclick="fetchData('/ss/zhaoqing.icu')">应急网络</button>
        </div></div>		
        <div class="group-container"><div class="group-title">隧道连接</div><div class="btn-grid">
          <button class="green" onclick="fetchData('/edge/niclai.vip')">个人机房</button>
          <button class="green" onclick="fetchData('/edge/zhaoqing.city')">肇庆机房</button>
          <button class="green" onclick="fetchData('/edge/qingyuan.city')">清远机房</button>
          <button class="green" onclick="fetchData('/edge/sihui.city')">四会机房</button>
		  <button class="green" onclick="fetchData('/edge/maoming.city')">茂名机房</button>
          <button class="green" onclick="fetchData('/edge/zhaoqing.icu')">肇庆应急</button>
        </div></div>
		<div class="group-container"><div class="group-title">影子连接</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('/ss/niclai.vip')">个人机房</button>
          <button class="blue" onclick="fetchData('/ss/zhaoqing.city')">肇庆机房</button>
          <button class="blue" onclick="fetchData('/ss/qingyuan.city')">清远机房</button>
          <button class="blue" onclick="fetchData('/ss/sihui.city')">四会机房</button>
		  <button class="blue" onclick="fetchData('/ss/maoming.city')">茂名机房</button>
          <button class="blue" onclick="fetchData('/ss/zhaoqing.icu')">肇庆应急</button>
        </div></div>
		<div class="group-container"><div class="group-title">自由中国</div><div class="btn-grid">
          <button class="purple" onclick="fetchData('/freechina/niclai.vip')">个人机房</button>
          <button class="purple" onclick="fetchData('/freechina/zhaoqing.city')">肇庆机房</button>
          <button class="purple" onclick="fetchData('/freechina/qingyuan.city')">清远机房</button>
          <button class="purple" onclick="fetchData('/freechina/sihui.city')">四会机房</button>
		  <button class="purple" onclick="fetchData('/freechina/maoming.city')">茂名机房</button>
          <button class="purple" onclick="fetchData('/freechina/zhaoqing.icu')">肇庆应急</button>
        </div></div>
		<div class="group-container"><div class="group-title">实时连接</div><div class="btn-grid">
          <button class="orange" onclick="fetchData('/bpb/niclai.vip')">个人机房</button>
          <button class="orange" onclick="fetchData('/bpb/zhaoqing.city')">肇庆机房</button>
          <button class="orange" onclick="fetchData('/bpb/qingyuan.city')">清远机房</button>
          <button class="orange" onclick="fetchData('/bpb/sihui.city')">四会机房</button>
		  <button class="orange" onclick="fetchData('/bpb/maoming.city')">茂名机房</button>
          <button class="orange" onclick="fetchData('/bpb/zhaoqing.icu')">肇庆应急</button>
        </div></div>
        <div class="group-container"><div class="group-title">基地连接</div><div class="btn-grid">
          <button class="red" onclick="fetchData('station/home')">移动机房</button>
          <button class="red" onclick="fetchData('station/chinatelecom')">电信机房</button>
          <button class="red" onclick="fetchData('station/huahailink')">工作网络</button>
          <button class="red" onclick="fetchData('station/niclai')">个人机房</button>
          <button class="red" onclick="fetchData('station/zhaoqing')">肇庆机房</button>
          <button class="red" onclick="fetchData('station/oracle')">大阪机房</button>
          <button class="red" onclick="fetchData('station/sihui')">四会机房</button>
          <button class="red" onclick="fetchData('station/auto')">最新数据</button>
          <button class="red" onclick="fetchData('station/allnodes')">全部机房</button>
        </div></div>      
		
		<div class="group-container"><div class="group-title">清远机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('qingyuan.city/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('qingyuan.city/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('qingyuan.city/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('qingyuan.city/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('qingyuan.city/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/qingyuan.city')">影子网络</button>
        </div></div>

		<div class="group-container"><div class="group-title">肇庆机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('zhaoqing.city/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('zhaoqing.city/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('zhaoqing.city/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('zhaoqing.city/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('zhaoqing.city/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/zhaoqing.city')">影子网络</button>
        </div></div>

		<div class="group-container"><div class="group-title">茂名机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('maoming.city/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('maoming.city/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('maoming.city/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('maoming.city/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('maoming.city/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/maoming.city')">影子网络</button>
        </div></div>
		
		<div class="group-container"><div class="group-title">四会机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('sihui.city/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('sihui.city/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('sihui.city/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('sihui.city/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('sihui.city/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/sihui.city')">影子网络</button>
        </div></div>
		
		<div class="group-container"><div class="group-title">个人机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('niclai.vip/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('niclai.vip/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('niclai.vip/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('niclai.vip/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('niclai.vip/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/niclai.vip')">影子网络</button>
        </div></div>
		
		<div class="group-container"><div class="group-title">华海机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('huahai.asia/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('huahai.asia/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('huahai.asia/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('huahai.asia/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('huahai.asia/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/huahai.asia')">影子网络</button>
        </div></div>
		
		<div class="group-container"><div class="group-title">应急机房</div><div class="btn-grid">
          <button class="blue" onclick="fetchData('zhaoqing.icu/edge')">边缘网络</button>
          <button class="blue" onclick="fetchData('zhaoqing.icu/home')">家庭网络</button>
          <button class="blue" onclick="fetchData('zhaoqing.icu/huhailink')">工作网络</button>
          <button class="blue" onclick="fetchData('zhaoqing.icu/cmcc)">移动网络</button>
		  <button class="blue" onclick="fetchData('zhaoqing.icu/chinatelecom')">电信网络</button>
		  <button class="blue" onclick="fetchData('ss/zhaoqing.icu')">影子网络</button>
        </div></div>
		
        <div class="group-container"><div class="group-title">订阅链接</div><div class="btn-grid">
          <button class="teal" onclick="copyUrl()" style="width: 80%;">复制上方选中节点的订阅链接</button>
          <div class="linkUrl-box" id="linkUrl">点击任意节点获取当前域名订阅链接...</div>
        </div></div>
        <div class="group-container"><div class="group-title">实际地址</div><div class="btn-grid">
          <button class="teal" onclick="copySourceUrl()" style="width: 80%;">复制上方选中节点的实际地址</button>
          <div class="linkUrl-box" id="sourceUrl">点击任意节点获取真实地址...</div>
        </div></div>
        <div class="group-container"><div class="group-title">节点内容</div><div class="btn-grid">
			<button class="teal" onclick="copyText()" style="width: 80%;">复制上方选中节点的具体内容</button>
			<div class="linkUrl-box" id="output">点击任意节点获取内容...</div>
		</div></div>
    </div>
    <div id="customAlert"></div>
    
    <script>
        const FRONTEND_MAPPINGS = ${mappingsJson};

        function copyUrl() {
            const t = document.getElementById('linkUrl').textContent;
            if(!t || t.includes('点击')) return;
            navigator.clipboard.writeText(t).then(() => {
                const a = document.getElementById('customAlert');
                a.textContent = "订阅地址已复制"; a.style.background = "#28a745"; a.style.display = "block";
                setTimeout(() => a.style.display = "none", 2000);
            });
        }
        
        function copySourceUrl() {
            const t = document.getElementById('sourceUrl').textContent;
            if(!t || t.includes('点击') || t.includes('未在配置中找到')) return;
            navigator.clipboard.writeText(t).then(() => {
                const a = document.getElementById('customAlert');
                a.textContent = "实际地址已复制"; a.style.background = "#28a745"; a.style.display = "block";
                setTimeout(() => a.style.display = "none", 2000);
            });
        }
        
        async function fetchData(p) {
            const o = document.getElementById('output');
            const linkBox = document.getElementById('linkUrl');
            const sourceBox = document.getElementById('sourceUrl');

            const key = p.replace(/^\\/+/, '');
            const subUrl = window.location.origin + '/' + key;
            linkBox.textContent = subUrl;

            if(FRONTEND_MAPPINGS[key]) {
                 sourceBox.textContent = FRONTEND_MAPPINGS[key];
            } else {
                 sourceBox.textContent = "未在配置中找到此链接";
            }

            o.textContent = "节点内容获取中...";
            try {
                const realUrl = FRONTEND_MAPPINGS[key];
                if (!realUrl) {
                    o.textContent = "未在配置中找到对应的真实地址";
                    return;
                }
                // 改为通过 Worker 代理端点获取，解决跨域
                const proxyUrl = window.location.origin + '/proxy?url=' + encodeURIComponent(realUrl);
                const r = await fetch(proxyUrl);
                if (!r.ok) {
                    o.textContent = "请求失败，状态码: " + r.status;
                    return;
                }
                o.textContent = await r.text();
            }
            catch(e) {
                o.textContent = "内容获取失败，请刷新重试";
            }
        }

        function copyText() {
            const t = document.getElementById('output').textContent;
            if(!t || t.includes('获取中')) return;
            navigator.clipboard.writeText(t).then(() => {
                const a = document.getElementById('customAlert');
                a.textContent = "节点内容已复制"; a.style.background = "#28a745"; a.style.display = "block";
                setTimeout(() => a.style.display = "none", 2000);
            });
        }
    </script>
</body>
</html>`;
}

// ==UserScript==
// @name         M3U8 下载器 · 发送到 Docker
// @namespace    m3u8-dl
// @version      1.0.2
// @description  识别播放页媒体与字幕，手动发送链接、名称、来源和媒体域请求信息
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const allowedHeaders = ['referer', 'origin', 'user-agent', 'authorization', 'cookie'];
  const fileFormats = [
    { ext: 'mp4', mime: 'video/mp4', aliases: ['application/mp4'] },
    { ext: 'webm', mime: 'video/webm', aliases: [] },
    { ext: 'mkv', mime: 'video/x-matroska', aliases: [] },
    { ext: 'mov', mime: 'video/quicktime', aliases: [] },
    { ext: 'mp3', mime: 'audio/mpeg', aliases: ['audio/mp3', 'audio/x-mp3', 'audio/x-mpeg'] },
    { ext: 'm4a', mime: 'audio/mp4', aliases: ['audio/m4a', 'audio/x-m4a'] },
    { ext: 'aac', mime: 'audio/aac', aliases: ['audio/aacp', 'audio/x-aac'] },
    { ext: 'wav', mime: 'audio/wav', aliases: ['audio/wave', 'audio/x-wav', 'audio/vnd.wave'] },
    { ext: 'flac', mime: 'audio/flac', aliases: ['audio/x-flac'] },
    { ext: 'ogg', mime: 'audio/ogg', aliases: ['application/ogg'] },
    { ext: 'opus', mime: 'audio/opus', aliases: [] },
    { ext: 'weba', mime: 'audio/webm', aliases: [] },
    { ext: 'vtt', mime: 'text/vtt', aliases: [] },
    { ext: 'srt', mime: 'application/x-subrip', aliases: ['text/srt', 'text/x-srt'] },
    { ext: 'ass', mime: 'text/x-ass', aliases: ['text/ass'] },
    { ext: 'ssa', mime: 'text/x-ssa', aliases: ['text/ssa'] },
  ];
  function httpUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }
  function mediaType(url, mime = '', disposition = '') {
    const parsed = new URL(url);
    const attachment = disposition || parsed.searchParams.get('response-content-disposition') || '';
    const encoded = /filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i.exec(attachment)?.[1];
    let filename = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(attachment)?.slice(1).find(Boolean) || '';
    if (encoded) {
      try { filename = decodeURIComponent(encoded.trim().replace(/^"|"$/g, '')); } catch { filename = ''; }
    }
    const names = [parsed.pathname, filename.trim(), parsed.searchParams.get('filename') || ''];
    const contentType = (mime || parsed.searchParams.get('response-content-type') || '').split(';')[0].trim().toLowerCase();
    if (/mpegurl/i.test(contentType) || names.some(name => /\.m3u8?$/i.test(name))) return 'application/vnd.apple.mpegurl';
    // Explicit filenames distinguish Opus from other Ogg audio without re-encoding.
    const named = fileFormats.find(format => names.some(name => name.toLowerCase().endsWith(`.${format.ext}`)));
    const typed = fileFormats.find(format => format.mime === contentType || format.aliases.includes(contentType));
    return (named || typed)?.mime || '';
  }
  function cleanHeaders(input) {
    const output = {};
    for (const [name, value] of Object.entries(input || {})) {
      const key = name.toLowerCase();
      if (allowedHeaders.includes(key) && typeof value === 'string' && !/[\r\n]/.test(value)) output[key] = value;
    }
    return output;
  }
  function scopedHeaders(headers, from, to) {
    const output = cleanHeaders(headers);
    if (new URL(from).origin !== new URL(to).origin) {
      delete output.cookie;
      delete output.authorization;
    }
    return output;
  }
  function referrerFor(page, target, policy = 'strict-origin-when-cross-origin') {
    const from = new URL(page);
    const to = new URL(target);
    const same = from.origin === to.origin;
    const downgrade = from.protocol === 'https:' && to.protocol === 'http:';
    if (policy === 'no-referrer' || (policy === 'same-origin' && !same)) return '';
    if (policy === 'unsafe-url') return from.href;
    if (downgrade && policy !== 'origin' && policy !== 'origin-when-cross-origin') return '';
    if (policy === 'no-referrer-when-downgrade' || (same && !['origin', 'strict-origin'].includes(policy))) return from.href;
    return `${from.origin}/`;
  }
  function cookieHeader(cookies, target) {
    const url = new URL(target);
    return cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      const path = cookie.path || '/';
      return (cookie.hostOnly ? url.hostname === domain : url.hostname === domain || url.hostname.endsWith(`.${domain}`)) &&
        (url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/'))) &&
        (!cookie.secure || url.protocol === 'https:') && (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000);
    }).sort((a, b) => (b.path || '/').length - (a.path || '/').length)
      .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  function payloadFor(item, title, sourceUrl, cookies) {
    const requestHeaders = cleanHeaders(item.headers);
    if (cookies) requestHeaders.cookie = cookies;
    const ext = `.${fileFormats.find(format => format.mime === item.type)?.ext || 'mp4'}`;
    const stem = (title.trim() || '视频').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
    const suffix = ['.vtt', '.srt', '.ass', '.ssa'].includes(ext) ? `.${new URL(item.url).pathname.split('/').pop().replace(/\.[^.]+$/, '').slice(0, 36) || '字幕'}` : '';
    return { url: item.url, type: item.type, name: `${stem}${suffix}${ext}`, sourceUrl, requestHeaders };
  }
  // Also usable by the repository's Node tests without a browser or extension.
  if (typeof module === 'object' && module.exports) {
    module.exports = { httpUrl, mediaType, cleanHeaders, scopedHeaders, referrerFor, cookieHeader, payloadFor };
    return;
  }

  const page = unsafeWindow;
  const resources = new Map();
  const messageKind = 'm3u8-dl-resource-v1';
  let render = () => {};
  function record(value, mime = '', headers = {}, cookiesAllowed = true) {
    const url = httpUrl(value, location.href);
    if (!url) return;
    const type = mediaType(url, mime);
    if (!type) return;
    const previous = resources.get(url);
    const captured = cleanHeaders(headers);
    const item = {
      url, type, frameUrl: location.href, cookiesAllowed,
      headers: { referer: referrerFor(location.href, url, document.referrerPolicy || undefined), 'user-agent': navigator.userAgent,
        ...previous?.headers, ...captured },
    };
    // DOM/performance sightings must not replace the more accurate request context.
    if (previous && !Object.keys(captured).length) return;
    if (!resources.has(url) && resources.size >= 200) return;
    resources.set(url, item);
    if (window !== window.top) window.top.postMessage({ kind: messageKind, item }, '*');
    render();
  }
  const readHeaders = value => {
    try { return Object.fromEntries(new Headers(value).entries()); } catch { return {}; }
  };
  const originalFetch = page.fetch;
  if (originalFetch) page.fetch = function (input, init) {
    let url = '';
    let headers = {};
    let credentials = 'same-origin';
    try {
      url = httpUrl(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      headers = readHeaders(init?.headers || input?.headers);
      credentials = init?.credentials || input?.credentials || credentials;
      if (url) {
        headers.referer ??= referrerFor(location.href, url, init?.referrerPolicy || input?.referrerPolicy || document.referrerPolicy || undefined);
        if ((init?.mode || input?.mode || 'cors') === 'cors' && new URL(url).origin !== location.origin) headers.origin ??= location.origin;
        record(url, '', headers, credentials === 'include' || (credentials === 'same-origin' && new URL(url).origin === location.origin));
      }
    } catch { /* Observing must never prevent the page request. */ }
    return originalFetch.apply(this, arguments).then(response => {
      try {
        const target = httpUrl(response.url || url, location.href);
        if (!target) return response;
        const type = response.headers.get('content-type') || '';
        const scoped = scopedHeaders(headers, url || target, target);
        const allowed = credentials === 'include' || (credentials === 'same-origin' && new URL(target).origin === location.origin);
        record(target, mediaType(target, type, response.headers.get('content-disposition') || '') || type, scoped, allowed);
        if (!mediaType(target, type) && /text\/plain|octet-stream/i.test(type) && response.body) {
          // Read only a bounded prefix to identify disguised HLS; never buffer a video.
          const reader = response.clone().body.getReader();
          void (async () => {
            let prefix = '';
            const decoder = new TextDecoder();
            try {
              while (prefix.length < 1024) {
                const { done, value } = await reader.read();
                if (done) break;
                prefix += decoder.decode(value.subarray(0, 1024), { stream: true });
                if (prefix.trimStart().startsWith('#EXTM3U')) { record(target, 'application/vnd.apple.mpegurl', scoped, allowed); break; }
                if (prefix.trimStart().length >= 7) break;
              }
            } finally { void reader.cancel().catch(() => {}); }
          })().catch(() => {});
        }
      } catch { /* The original response remains untouched. */ }
      return response;
    });
  };
  const xhrState = new WeakMap();
  const proto = page.XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSetHeader = proto.setRequestHeader;
  const originalSend = proto.send;
  proto.open = function (method, url) {
    xhrState.set(this, { url: httpUrl(url, location.href), headers: {} });
    return originalOpen.apply(this, arguments);
  };
  proto.setRequestHeader = function (name, value) {
    const result = originalSetHeader.apply(this, arguments);
    const state = xhrState.get(this);
    if (state) state.headers[name.toLowerCase()] = String(value);
    return result;
  };
  proto.send = function () {
    const state = xhrState.get(this);
    if (state?.url) {
      const allowed = this.withCredentials || new URL(state.url).origin === location.origin;
      state.headers.referer ??= referrerFor(location.href, state.url, document.referrerPolicy || undefined);
      if (new URL(state.url).origin !== location.origin) state.headers.origin ??= location.origin;
      record(state.url, '', state.headers, allowed);
      this.addEventListener('load', () => {
        try {
          const target = httpUrl(this.responseURL || state.url, location.href);
          const headers = scopedHeaders(state.headers, state.url, target);
          const mime = this.getResponseHeader('content-type') || '';
          const hls = ['', 'text'].includes(this.responseType) && this.responseText.slice(0, 1024).trimStart().startsWith('#EXTM3U');
          record(target, hls ? 'application/vnd.apple.mpegurl' : mediaType(target, mime, this.getResponseHeader('content-disposition') || '') || mime, headers,
            this.withCredentials || new URL(target).origin === location.origin);
        } catch { /* Binary responses do not expose responseText. */ }
      }, { once: true });
    }
    return originalSend.apply(this, arguments);
  };

  function scan() {
    if (typeof performance !== 'undefined') {
      for (const entry of performance.getEntriesByType('resource')) record(entry.name);
    }
    for (const element of document.querySelectorAll('video, audio, source, track')) {
      const crossOrigin = element.crossOrigin || element.parentElement?.crossOrigin;
      record(element.currentSrc || element.src, element.type || (element.tagName === 'TRACK' ? 'text/vtt' : ''), {}, crossOrigin !== 'anonymous');
    }
  }
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) record(entry.name);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch { /* Older browsers still use DOM/fetch/XHR observation. */ }
  document.addEventListener('loadedmetadata', scan, true);
  document.addEventListener('load', scan, true);
  setInterval(scan, 3000);
  if (window !== window.top) return;

  window.addEventListener('message', event => {
    const item = event.data?.item;
    if (event.data?.kind !== messageKind || !item || !event.source) return;
    const url = httpUrl(item.url);
    const frameUrl = httpUrl(item.frameUrl);
    if (!url || !frameUrl || new URL(frameUrl).origin !== event.origin || !mediaType(url, item.type)) return;
    if (resources.size >= 200 && !resources.has(url)) return;
    resources.set(url, { url, frameUrl, type: mediaType(url, item.type), headers: cleanHeaders(item.headers), cookiesAllowed: item.cookiesAllowed !== false });
    render();
  });

  function mount() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:12px;bottom:16px;z-index:2147483647;color-scheme:light;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial;font:14px/1.5 system-ui,sans-serif;color:#24334b}*{box-sizing:border-box}
      button,input{font:inherit}button{cursor:pointer;background:#edf4ff;color:#1760d5;border:1px solid #d6e4fa;border-radius:8px;padding:9px 12px;min-height:40px}
      button:disabled{opacity:.5;cursor:wait}input[type=text],input[type=password],input[type=url]{width:100%;min-height:42px;border:1px solid #d6dfed;border-radius:7px;padding:8px;color:#24334b;background:white}
      input[type=checkbox]{width:18px;height:18px;flex-shrink:0;accent-color:#1760d5}label{display:block;margin-top:10px}h2{font-size:18px;margin:0}
      section{width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 96px);overflow:auto;background:white;border:1px solid #dce5f2;border-radius:14px;box-shadow:0 8px 40px #18345426;padding:16px;margin-bottom:8px}
      section[hidden]{display:none}header,footer{display:flex;align-items:center;justify-content:space-between;gap:8px}small{display:block;color:#69788e;margin:6px 0;overflow-wrap:anywhere}
      #list{margin:12px 0;max-height:36vh;overflow:auto}.resource{display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-top:1px solid #edf1f7;margin:0}.resource span{min-width:0;overflow-wrap:anywhere}.resource small{font-size:12px;margin:2px 0}
      .primary{background:#1760d5;color:white;border-color:#1760d5}#status{white-space:pre-wrap;overflow-wrap:anywhere}#toggle{float:right}summary{cursor:pointer;padding:10px 0}
    </style><section hidden aria-label="发送媒体到 Docker"><header><h2>发送到下载器</h2><button id="close" aria-label="关闭">关闭</button></header>
      <details id="settings"><summary>连接设置</summary><label>Docker 下载器地址<input id="server" type="url" placeholder="http://192.168.1.10:6600" /></label>
      <label>访问密码（DS_SECRET）<input id="secret" type="password" autocomplete="off" /></label><button id="save">保存连接设置</button></details>
      <label>下载名称<input id="title" type="text" /></label><label>详情页地址<input id="source" type="url" /></label>
      <label><input id="cookies" type="checkbox" checked /> 附带媒体域 Cookie（首次需脚本猫授权）</label>
      <small>名称和详情页可修改；Cookie 只在点击发送时读取。Referer / Origin 根据播放页请求推导，不等于浏览器网络抓包。</small>
      <details><summary>手动添加媒体地址</summary><label>M3U8 / 视频 / 音频 / 字幕直链<input id="manual-url" type="url" placeholder="https://…" /></label><button id="manual-add">添加到列表</button><small>无后缀且无法识别的地址按 M3U8 添加。请求来源默认使用当前播放页。</small></details>
      <div id="list"></div><footer><button id="all">全选 / 取消</button><button id="refresh">重新扫描</button><button id="send" class="primary">发送所选</button></footer><small id="status" role="status"></small>
      </section><button id="toggle">下载 · 0</button>`;
    document.documentElement.append(host);
    const $ = id => root.getElementById(id);
    const panel = root.querySelector('section');
    const selected = new Set();
    let busy = false;
    let wasOpen = false;
    const status = text => { $('status').textContent = text; };
    const settings = GM_getValue('docker-settings', {});
    $('server').value = settings.server || '';
    $('secret').value = settings.secret || '';
    $('settings').open = !settings.server;
    function open() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !wasOpen) {
        $('title').value = document.title;
        $('source').value = location.href;
        wasOpen = true;
      }
      scan();
      render();
    }
    $('toggle').onclick = open;
    $('close').onclick = () => { panel.hidden = true; };
    GM_registerMenuCommand('打开媒体发送面板', () => { if (panel.hidden) open(); });
    $('save').onclick = () => {
      const server = httpUrl($('server').value.trim());
      if (!server || !$('secret').value.trim()) { status('请填写有效的下载器地址及 DS_SECRET。'); return; }
      GM_setValue('docker-settings', { server: server.replace(/\/$/, ''), secret: $('secret').value.trim() });
      status('连接设置已保存在脚本猫中。');
      $('settings').open = false;
    };
    render = () => {
      $('toggle').textContent = `下载 · ${resources.size}`;
      if (panel.hidden) return;
      const list = $('list');
      list.replaceChildren();
      if (!resources.size) { list.textContent = '尚未发现媒体。开始播放，并开启需要的字幕；安装脚本后请刷新页面。'; return; }
      for (const item of resources.values()) {
        const label = document.createElement('label');
        label.className = 'resource';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(item.url);
        checkbox.disabled = busy;
        checkbox.onchange = () => checkbox.checked ? selected.add(item.url) : selected.delete(item.url);
        const text = document.createElement('span');
        text.textContent = item.type.includes('mpegurl') ? 'HLS / M3U8' : item.type;
        const address = document.createElement('small');
        const url = new URL(item.url);
        address.textContent = `${url.host}${url.pathname}`;
        text.append(address);
        label.append(checkbox, text);
        list.append(label);
      }
    };
    $('all').onclick = () => {
      if (selected.size === resources.size) selected.clear();
      else for (const url of resources.keys()) selected.add(url);
      render();
    };
    $('refresh').onclick = () => { scan(); render(); };
    $('manual-add').onclick = () => {
      if (busy) return;
      const url = httpUrl($('manual-url').value.trim());
      if (!url) { status('请粘贴以 http:// 或 https:// 开头的媒体直链。'); return; }
      if (!resources.has(url) && resources.size >= 200) { status('资源列表已满，请刷新页面后重试。'); return; }
      record(url, mediaType(url) || 'application/vnd.apple.mpegurl');
      selected.add(url);
      $('manual-url').value = '';
      render();
      status('已添加并选中媒体地址。请确认播放页来源后发送。');
    };
    function readCookies(url) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cookie 授权超时，请在脚本猫中允许读取媒体域 Cookie 后重试。')), 30000);
        try {
          GM_cookie('list', { url }, (cookies, error) => {
            clearTimeout(timer);
            if (error) reject(new Error('未取得媒体域 Cookie 授权，请允许后重试，或取消勾选 Cookie。'));
            else resolve(cookieHeader(cookies || [], url));
          });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    }
    $('send').onclick = async () => {
      if (busy) return;
      const server = httpUrl($('server').value.trim());
      const secret = $('secret').value.trim();
      const source = httpUrl($('source').value.trim());
      const chosen = [...selected].map(url => resources.get(url)).filter(Boolean);
      if (!server || !secret || !source) { status('请填写下载器地址、访问密码和详情页地址。'); return; }
      if (!chosen.length || chosen.length > 100) { status('每次请选择 1–100 个媒体或字幕。'); return; }
      busy = true;
      for (const id of ['send', 'all', 'refresh']) $(id).disabled = true;
      render();
      try {
        const title = $('title').value;
        const includeCookies = $('cookies').checked;
        const data = [];
        status('正在读取选中媒体的请求信息…');
        for (const item of chosen) {
          const headers = { ...item.headers };
          delete headers.cookie;
          const cookies = includeCookies && item.cookiesAllowed ? await readCookies(item.url) : '';
          data.push(payloadFor({ ...item, headers }, title, source, cookies));
        }
        const endpoint = new URL(server);
        endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '').replace(/\/api\/cat-catch$/, '')}/api/cat-catch`;
        endpoint.search = '';
        status('正在发送到 Docker…');
        const result = await new Promise((resolve, reject) => GM_xmlhttpRequest({
          method: 'POST', url: endpoint.href, anonymous: true, timeout: 30000,
          headers: { 'Content-Type': 'application/json', Authorization: secret },
          data: JSON.stringify({ action: 'catch', data }),
          onload: response => {
            try {
              const body = JSON.parse(response.responseText);
              if (response.status < 200 || response.status >= 300 || body.code !== 0) throw new Error(body.message || `HTTP ${response.status}`);
              resolve(body.data);
            } catch (error) { reject(error); }
          },
          onerror: () => reject(new Error('无法连接下载器，请检查地址、端口及脚本猫连接授权。')),
          ontimeout: () => reject(new Error('下载器响应超时，请检查队列后再重试。')),
        }));
        status(`已加入 ${result.added} 项，跳过 ${result.skipped} 项。可到下载器查看进度。`);
      } catch (error) { status(error.message || '发送失败'); }
      finally {
        busy = false;
        for (const id of ['send', 'all', 'refresh']) $(id).disabled = false;
        render();
      }
    };
    render();
    scan();
  }
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { httpUrl, mediaType, scopedHeaders, referrerFor, cookieHeader, payloadFor } = require('../examples/scriptcat-downloader.user.js');

test('ScriptCat preserves signed queries, titles and separate page/media credential identities', () => {
  const url = 'https://cdn.example/a/video.m3u8?token=a%2Bb&expires=9999999999&token_path=%2Fa%2F';
  assert.equal(httpUrl(url), url);
  assert.equal(httpUrl('javascript:alert(1)'), '');
  assert.equal(httpUrl('https://user:pass@example.com/a'), '');
  const item = { url, type: mediaType(url), headers: { origin: 'https://page.example', referer: 'https://page.example/', authorization: 'media-token' } };
  const payload = payloadFor(item, '作品 / 第1集', 'https://page.example/detail/1', 'cdn=session');
  assert.equal(payload.name, '作品 _ 第1集.mp4');
  assert.equal(payload.url, url);
  assert.equal(payload.sourceUrl, 'https://page.example/detail/1');
  assert.equal(payload.requestHeaders.cookie, 'cdn=session');
  assert.equal(payload.requestHeaders.authorization, 'media-token');
  assert.equal(payloadFor({ ...item, url: 'https://cdn.example/zh.vtt', type: 'text/vtt' }, '作品', payload.sourceUrl, '').name, '作品.zh.vtt');
  assert.equal(mediaType('https://cdn.example/index.txt', 'application/x-mpegURL'), 'application/vnd.apple.mpegurl');
  assert.equal(mediaType('https://cdn.example/video.ts'), '');
  assert.deepEqual(scopedHeaders({ Cookie: 'secret', Authorization: 'secret', Origin: 'https://page.example', Host: 'bad' }, url, 'https://other.example/a'), { origin: 'https://page.example' });
  assert.equal(referrerFor('https://page.example/detail/1', url), 'https://page.example/');
  assert.equal(referrerFor('https://page.example/detail/1', 'https://page.example/a'), 'https://page.example/detail/1');
  assert.equal(referrerFor('https://page.example/detail/1', url, 'no-referrer'), '');
});

test('ScriptCat cookie selection scopes HttpOnly cookies to media host, path, scheme and expiry', () => {
  const cookie = { name: 'session', value: 'media', domain: '.cdn.example', path: '/a', httpOnly: true, secure: true };
  const cookies = [cookie,
    { ...cookie, domain: 'page.example', name: 'page' },
    { ...cookie, path: '/ab', name: 'wrongpath' },
    { ...cookie, hostOnly: true, name: 'hostonly' },
    { ...cookie, expirationDate: 1, name: 'expired' },
    { ...cookie, name: 'specific', path: '/a/b' },
  ];
  assert.equal(cookieHeader(cookies, 'https://sub.cdn.example/a/b/1.m3u8'), 'specific=media; session=media');
  assert.equal(cookieHeader(cookies, 'http://sub.cdn.example/a/b/1.m3u8'), '');
  assert.equal(cookieHeader(cookies, 'https://other.example/a/b/1.m3u8'), '');
});

test('ScriptCat recognizes extensionless object storage links without altering signatures', () => {
  const url = 'https://storage.example/8895809daf474dc68854afd2ff38ca8e086?response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27Love.in.Disguise.S01E03.mp4&X-Amz-Signature=a%2Bb&X-Amz-Expires=900';
  assert.equal(mediaType(url), 'video/mp4');
  const payload = payloadFor({ url, type: mediaType(url), headers: {} }, '第3集', 'https://page.example/watch', '');
  assert.equal(payload.url, url);
  assert.equal(payload.name, '第3集.mp4');
  assert.equal(mediaType('https://storage.example/object', 'application/octet-stream', 'attachment; filename="字幕.vtt"'), 'text/vtt');
  assert.equal(mediaType('https://storage.example/object?response-content-type=video%2Fmp4'), 'video/mp4');
  assert.equal(mediaType('https://storage.example/object?filename=video.mp4'), 'video/mp4');
  assert.equal(mediaType('https://storage.example/object?random=video.mp4'), '');
  assert.equal(mediaType('https://storage.example/object', '', "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.srt"), 'application/x-subrip');
});

test('ScriptCat recognizes audio extensions, MIME aliases and attachment names and preserves audio filenames', () => {
  const samples = [
    ['mp3', 'audio/mpeg', 'audio/mp3'], ['m4a', 'audio/mp4', 'audio/x-m4a'],
    ['aac', 'audio/aac', 'audio/aacp'], ['wav', 'audio/wav', 'audio/x-wav'],
    ['flac', 'audio/flac', 'audio/x-flac'], ['ogg', 'audio/ogg', 'application/ogg'],
    ['opus', 'audio/opus', 'audio/opus'], ['weba', 'audio/webm', 'audio/webm'],
  ];
  for (const [ext, mime, alias] of samples) {
    assert.equal(mediaType(`https://cdn.example/song.${ext}?token=a%2Bb`), mime);
    assert.equal(mediaType('https://cdn.example/object', `${alias}; charset=utf-8`), mime);
    assert.equal(mediaType('https://cdn.example/object', 'application/octet-stream', `attachment; filename="song.${ext}"`), mime);
    const url = `https://cdn.example/object?filename=song.${ext}&token=a%2Bb`;
    const data = payloadFor({ url, type: mediaType(url), headers: {} }, '歌曲名称', 'https://page.example/album', '');
    assert.equal(data.name, `歌曲名称.${ext}`);
    assert.equal(data.url, url);
  }
  assert.equal(mediaType('https://cdn.example/song.opus', 'audio/ogg'), 'audio/opus');
  assert.equal(mediaType('https://cdn.example/a.ts', 'video/mp2t'), '');
  assert.equal(mediaType('https://cdn.example/a.mpd', 'application/dash+xml'), '');
});

test('ScriptCat observes real fetch/XHR response objects without consuming page responses', async () => {
  const messages = [];
  class XHR {
    open() {}
    setRequestHeader() {}
    send() {
      this.responseURL = 'https://cdn.example/subtitles?id=1';
      this.responseType = '';
      this.responseText = 'WEBVTT';
      this.listener();
    }
    getResponseHeader() { return 'text/vtt'; }
    addEventListener(_name, fn) { this.listener = fn; }
  }
  const page = {
    XMLHttpRequest: XHR,
    fetch: async () => new Response('#EXTM3U\n#EXTINF:1,\na.ts', { headers: { 'content-type': 'text/plain' } }),
  };
  const sandbox = {
    unsafeWindow: page, window: { top: { postMessage: value => messages.push(value) } },
    location: new URL('https://page.example/player'), document: { referrerPolicy: '', addEventListener() {} },
    navigator: { userAgent: 'fixture browser' }, URL, Headers, TextDecoder, setInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../examples/scriptcat-downloader.user.js'), 'utf8'), sandbox);
  const response = await page.fetch('https://cdn.example/index.txt', { credentials: 'include', headers: { Authorization: 'signed' } });
  assert.match(await response.text(), /^#EXTM3U/);
  for (let i = 0; i < 20 && !messages.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(messages[0].item.url, 'https://cdn.example/index.txt');
  assert.equal(messages[0].item.cookiesAllowed, true);
  assert.equal(messages[0].item.headers.authorization, 'signed');
  assert.equal(messages[0].item.headers.origin, 'https://page.example');
  assert.equal(messages[0].item.headers.referer, 'https://page.example/');
  await page.fetch('https://cdn.example/omit.m3u8', { credentials: 'omit' });
  assert.equal(messages.find(message => message.item.url.endsWith('/omit.m3u8')).item.cookiesAllowed, false);
  const xhr = new XHR();
  xhr.open('GET', 'https://cdn.example/subtitles?id=1');
  xhr.withCredentials = true;
  xhr.setRequestHeader('Authorization', 'subtitle-token');
  xhr.send();
  assert.equal(messages.at(-1).item.type, 'text/vtt');
  assert.equal(messages.at(-1).item.headers.authorization, 'subtitle-token');
});

test('ScriptCat panel sends selected media only, reads target cookies on click and keeps Docker auth separate', async () => {
  class Element {
    constructor() { this.children = []; this.style = {}; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
  }
  const fields = new Map();
  const panel = new Element();
  panel.hidden = true;
  const root = {
    getElementById(id) {
      if (!fields.has(id)) fields.set(id, new Element());
      return fields.get(id);
    },
    querySelector: () => panel,
  };
  root.getElementById('cookies').checked = true;
  const element = () => Object.assign(new Element(), { attachShadow: () => root });
  const requests = [];
  const cookieReads = [];
  const historical = [];
  class XHR { open() {} setRequestHeader() {} send() {} }
  const page = { XMLHttpRequest: XHR, fetch: async () => new Response('', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) };
  const window = { addEventListener() {} };
  window.top = window;
  const sandbox = {
    unsafeWindow: page, window, location: new URL('https://page.example/detail/1'),
    document: { title: '作品名称', documentElement: new Element(), createElement: element, referrerPolicy: '', addEventListener() {}, querySelectorAll: () => [] },
    navigator: { userAgent: 'fixture browser' }, URL, Headers, TextDecoder, setInterval() {}, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => historical },
    GM_getValue: () => ({ server: 'https://docker.example/prefix', secret: 'docker-secret' }),
    GM_setValue() {}, GM_registerMenuCommand() {},
    GM_cookie(action, details, callback) {
      cookieReads.push({ action, details });
      callback([{ name: 'session', value: 'media-only', domain: 'cdn.example', path: '/', hostOnly: true, httpOnly: true }]);
    },
    GM_xmlhttpRequest(details) {
      requests.push(details);
      details.onload({ status: 200, responseText: JSON.stringify({ code: 0, data: { added: 1, skipped: 0 } }) });
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../examples/scriptcat-downloader.user.js'), 'utf8'), sandbox);
  await page.fetch('https://cdn.example/video.m3u8?token=abc', { credentials: 'include', headers: { Authorization: 'media-secret' } });
  await page.fetch('https://cdn.example/other.m3u8?token=def', { credentials: 'include' });
  assert.equal(cookieReads.length, 0);
  assert.equal(requests.length, 0);
  root.getElementById('toggle').onclick();
  assert.equal(root.getElementById('title').value, '作品名称');
  const checkbox = root.getElementById('list').children[0].children[0];
  checkbox.checked = true;
  checkbox.onchange();
  await root.getElementById('send').onclick();
  assert.equal(cookieReads.length, 1);
  assert.equal(cookieReads[0].details.url, 'https://cdn.example/video.m3u8?token=abc');
  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.equal(sent.url, 'https://docker.example/prefix/api/cat-catch');
  assert.equal(sent.headers.Authorization, 'docker-secret');
  assert.equal(sent.anonymous, true);
  const body = JSON.parse(sent.data);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].name, '作品名称.mp4');
  assert.equal(body.data[0].sourceUrl, 'https://page.example/detail/1');
  assert.equal(body.data[0].requestHeaders.cookie, 'session=media-only');
  assert.equal(body.data[0].requestHeaders.authorization, 'media-secret');
  assert.match(root.getElementById('status').textContent, /已加入 1 项/);
  historical.push({ name: 'https://cdn.example/object?response-content-disposition=attachment%3Bfilename%3Dvideo.mp4' });
  root.getElementById('refresh').onclick();
  assert.equal(root.getElementById('list').children.length, 3);
  assert.equal(root.getElementById('list').children[2].children[1].textContent, 'video/mp4');
  const oldCheckbox = root.getElementById('list').children[0].children[0];
  oldCheckbox.checked = false;
  oldCheckbox.onchange();
  root.getElementById('manual-url').value = 'javascript:alert(1)';
  root.getElementById('manual-add').onclick();
  assert.equal(root.getElementById('list').children.length, 3);
  root.getElementById('manual-url').value = 'https://cdn.example/manual?id=1&token=a%2Bb';
  root.getElementById('manual-add').onclick();
  assert.equal(root.getElementById('list').children.length, 4);
  assert.equal(root.getElementById('list').children[3].children[0].checked, true);
  await root.getElementById('send').onclick();
  const manual = JSON.parse(requests[1].data).data;
  assert.equal(manual.length, 1);
  assert.equal(manual[0].url, 'https://cdn.example/manual?id=1&token=a%2Bb');
  assert.equal(manual[0].type, 'application/vnd.apple.mpegurl');
});

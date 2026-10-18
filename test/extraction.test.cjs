const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { VideoParser, extractMedia, getM3u8Urls, downloadResource, m3u8DLStop } = require('../cjs/index.js');
const { requestPage, resolveLocation } = require('../cjs/video-parser/request.js');
const { formatOptions } = require('../cjs/lib/format-options.js');
const { md5 } = require('../cjs/lib/utils.js');
const { DLServer } = require('../cjs/server/download-server.js');

async function serve(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(error => { res.writeHead(500).end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-extraction-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const json = (res, data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };

test('platform recognition accepts share text, enforces domain boundaries and selects parser mode', async () => {
  const input = '分享一个视频 https://v.douyin.com/abc123/ 复制打开观看';
  assert.equal(VideoParser.getPlatform(input).platform, 'douyin');
  assert.equal(VideoParser.getPlatform('https://www.weibo.com/tv/show/1034:123').platform, 'weibo');
  assert.equal(VideoParser.getPlatform('https://h5.pipix.com/s/abc/').platform, 'pipixia');
  assert.equal(VideoParser.getPlatform('https://example.com/video.mp4?signature=abc;').url, 'https://example.com/video.mp4?signature=abc;');
  for (const url of ['https://douyin.com.evil.example/video/1', 'https://notdouyin.com/123', 'javascript:alert(1)'])
    assert.equal(VideoParser.getPlatform(url).platform, 'unknown');
  const formatted = await formatOptions(input);
  assert.equal(formatted.url, 'https://v.douyin.com/abc123/'); assert.equal(formatted.options.type, 'parser');
  assert.equal((await formatOptions('https://v.douyin.com/abc123/', { type: 'm3u8' })).options.type, 'm3u8');
  assert.notEqual((await VideoParser.parse('https://example.com/watch/1')).code, 0);
});

async function platformFixture(t) {
  const records = [];
  const origin = await serve(t, async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    records.push({ path: url.pathname, query: url.searchParams, headers: req.headers, method: req.method });
    if (url.pathname === '/redirect/douyin') { res.writeHead(302, { location: '/video/7312345678901234567' }).end(); return; }
    if (url.pathname === '/redirect/pipixia') { res.writeHead(302, { location: '/item/888888/' }).end(); return; }
    if (url.pathname.startsWith('/video/') || url.pathname.startsWith('/item/')) { res.end('landing'); return; }
    const target = new URL(url.searchParams.get('target'));
    if (target.hostname === 'www.iesdouyin.com') {
      assert.equal(target.pathname, '/share/video/7312345678901234567');
      res.end(`<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [
        { desc: '抖音样例', video: { play_addr: { uri: 'video-id' } }, author: { nickname: '创作者' } },
      ] } } } })};</script>`); return;
    }
    if (target.hostname === 'h5.pipix.com') {
      assert.equal(target.searchParams.get('cell_id'), '888888');
      json(res, { data: { cell_comments: [{ comment_info: { item: { content: '皮皮虾样例', video: { video_high: { url_list: [{ url: 'https://media.example/high.mp4' }] } } } } }] } }); return;
    }
    if (target.pathname === '/tv/api/component') {
      assert.equal(req.method, 'POST'); assert.equal(req.headers.cookie, 'weibo-session');
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(new URLSearchParams(body).get('data')), { Component_Play_Playinfo: { oid: '1034:123456' } });
      json(res, { data: { Component_Play_Playinfo: { title: '微博样例', urls: { '720P': '//cdn.example/720.mp4', '1080P': '//cdn.example/1080.mp4' } } } }); return;
    }
    if (target.pathname === '/statuses/show') {
      json(res, { data: { page_info: { title: '微博正文视频', media_info: { stream_url_hd: 'https://cdn.example/post.mp4' } } } }); return;
    }
    res.writeHead(404).end();
  });
  const context = {
    request: (url, options) => requestPage(origin + '/proxy?target=' + encodeURIComponent(url), options),
    resolve: (url, options) => url.includes('/aweme/v1/play/') ? Promise.resolve('https://cdn.example/douyin.mp4') :
      resolveLocation(origin + (url.includes('pipix.com') ? '/redirect/pipixia' : '/redirect/douyin'), options),
  };
  return { context, records };
}

test('Douyin restores router-data parsing, resolves the video ID and requests the non-watermark play route', async t => {
  const { context, records } = await platformFixture(t);
  let playback;
  const resolve = context.resolve;
  context.resolve = (url, options) => { if (url.includes('/aweme/')) playback = url; return resolve(url, options); };
  const result = await VideoParser.parse('分享 https://v.douyin.com/sample/ 打开抖音', {}, context);
  assert.equal(result.code, 0, result.message); assert.equal(result.data.title, '抖音样例');
  assert.equal(result.data.url, 'https://cdn.example/douyin.mp4');
  assert.equal(new URL(playback).searchParams.get('video_id'), 'video-id'); assert.ok(!playback.includes('playwm'));
  assert.ok(records.some(record => record.path === '/video/7312345678901234567'));
});

test('Pipixia restores share redirect and high-quality video selection', async t => {
  const { context } = await platformFixture(t);
  const result = await VideoParser.parse('https://h5.pipix.com/s/sample/', undefined, context);
  assert.equal(result.code, 0, result.message); assert.equal(result.data.title, '皮皮虾样例');
  assert.equal(result.data.url, 'https://media.example/high.mp4');
});

test('Weibo requires Cookie and posts an encoded component request, choosing the best returned quality', async t => {
  const { context, records } = await platformFixture(t);
  const missing = await VideoParser.parse('https://weibo.com/tv/show/1034:123456', undefined, context);
  assert.match(missing.message, /Cookie/); assert.equal(records.length, 0);
  const result = await VideoParser.parse('https://weibo.com/tv/show?fid=1034%3A123456&from=share', { cookie: 'weibo-session' }, context);
  assert.equal(result.code, 0, result.message); assert.equal(result.data.url, 'https://cdn.example/1080.mp4');
  const post = await VideoParser.parse('https://m.weibo.cn/detail/123456', { cookie: 'weibo-session' }, context);
  assert.equal(post.data.url, 'https://cdn.example/post.mp4');
});

test('platform challenge and missing video data produce explicit errors without evaluating script', async () => {
  const context = { resolve: async () => 'https://www.douyin.com/video/123', request: async () => ({ text: '<script>throw new Error("do not execute")</script>', url: '', contentType: 'text/html' }) };
  const result = await VideoParser.parse('https://www.douyin.com/video/123', {}, context);
  assert.notEqual(result.code, 0); assert.match(result.message, /Cookie|结构/);
});

test('web extraction decodes escaped media URLs, relative attributes, HTML entities and compressed pages', async t => {
  const origin = await serve(t, (_req, res) => {
    const html = '<title>样例 &amp; 视频</title><script>var player={url:"https:\\u002f\\u002fcdn.example\\u002fa.m3u8?x=1\\u0026y=2"};</script>' +
      '<video src="../media/movie.mp4"></video><track src="/subs/zh.vtt"><source src="/api/hls.txt" type="application/x-mpegURL">' +
      '<script>var other="https%3A%2F%2Fcdn.example%2Fb.m3u8%3Fa%3D1";</script>';
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync(html));
  });
  const result = await extractMedia({ url: origin + '/watch/123', deep: 0 });
  assert.deepEqual(new Set(result.items.map(item => item.url)), new Set([
    'https://cdn.example/a.m3u8?x=1&y=2', 'https://cdn.example/b.m3u8?a=1', origin + '/media/movie.mp4', origin + '/subs/zh.vtt', origin + '/api/hls.txt',
  ]));
  assert.equal(result.items.find(item => item.url.endsWith('hls.txt')).type, 'm3u8');
  assert.equal(result.items[0].title, '样例 & 视频'); assert.equal(result.pagesVisited, 1);
});

test('recursive extraction follows same-origin links and cross-origin iframe without forwarding credentials', async t => {
  const seen = [];
  const iframe = await serve(t, (req, res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    res.end('<video src="/iframe.mp4"></video>');
  });
  const origin = await serve(t, (req, res) => {
    seen.push(req.url); assert.equal(req.headers.cookie, 'page-cookie');
    if (req.url === '/nested/entry') { res.writeHead(302, { location: '/nested/index.html' }).end(); return; }
    if (req.url === '/nested/index.html') { res.end(`<a href="./episode.html">第1集</a><a href="https://outside.example/page">external</a><iframe src="${iframe}/player"></iframe>`); return; }
    if (req.url === '/nested/episode.html') { res.end('<title>第1集</title><a href="../nested/index.html">back</a><source src="../streams/1.m3u8">'); return; }
    res.writeHead(404).end();
  });
  const root = origin + '/nested/entry';
  const shallow = await extractMedia({ url: root, deep: 0, headers: { Cookie: 'page-cookie', Authorization: 'page-token' } });
  assert.equal(shallow.items.length, 0);
  const deep = await extractMedia({ url: root, deep: 2, headers: { Cookie: 'page-cookie', Authorization: 'page-token' } });
  assert.equal(deep.items.length, 2); assert.equal(deep.errors.length, 0);
  assert.ok(deep.items.some(item => item.url === origin + '/streams/1.m3u8'));
  assert.ok(deep.items.some(item => item.url === iframe + '/iframe.mp4'));
  assert.ok(seen.filter(url => url === '/nested/episode.html').length === 1);
});

test('extraction bounds pages/results, applies path filter and exposes partial HTTP failures', async t => {
  const origin = await serve(t, (req, res) => {
    if (req.url === '/root') { res.end('<a href="/play/1">one</a><a href="/play/2">two</a><a href="/skip">skip</a>'); return; }
    if (req.url === '/missing') { res.writeHead(404).end(); return; }
    if (req.url.startsWith('/play/')) { res.end(`<source src="${req.url}.m3u8">`); return; }
    throw new Error('Unexpected page');
  });
  const result = await extractMedia({ url: origin + '/root', deep: 3, pathFilter: '/play/', maxPages: 2 });
  assert.equal(result.pagesVisited, 2); assert.equal(result.items.length, 1); assert.equal(result.truncated, true);
  const partial = await extractMedia({ url: '', urls: [origin + '/root', origin + '/missing'], deep: 1 });
  assert.ok(partial.items.length > 0); assert.ok(partial.errors.some(error => /HTTP 404/.test(error.message)));
  await assert.rejects(getM3u8Urls({ url: origin + '/missing' }), /HTTP 404/);
  const capped = await extractMedia({ url: origin + '/root', deep: 1, maxUrls: 1 });
  assert.equal(capped.items.length, 1); assert.equal(capped.truncated, true);
});

test('page extraction enforces decoded size and cancels stalled requests', async t => {
  const origin = await serve(t, (req, res) => {
    if (req.url === '/large') { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(Buffer.alloc(20000, 65))); }
  });
  const tooLarge = await extractMedia({ url: origin + '/large', maxHtmlSize: 100 });
  assert.match(tooLarge.errors[0].message, /大小限制/);
  const controller = new AbortController();
  const pending = extractMedia({ url: origin + '/stalled', signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /abort/i);
});

test('authenticated extraction API returns selectable results and only selected direct files enter the queue', async t => {
  let server; t.after(() => server?.close());
  const dir = await temporary(t);
  const requests = [];
  const cdn = await serve(t, (req, res) => {
    if (req.url === '/player') { assert.equal(req.headers.cookie, undefined); res.end('<track src="/iframe.vtt">'); return; }
    requests.push(req); res.end(req.url.endsWith('.vtt') ? 'WEBVTT\n' : Buffer.from('video bytes'));
  });
  const origin = await serve(t, (req, res) => {
    assert.equal(req.headers.cookie, 'page-cookie');
    res.end(`<title>样例</title><source src="${cdn}/movie.mp4"><track src="${cdn}/zh.vtt"><source src="${cdn}/unused.m3u8"><iframe src="${cdn}/player"></iframe>`);
  });
  server = new DLServer({ port: 0, cacheDir: path.join(dir, 'cache'), token: 'test-secret' }); await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}/api/`;
  const call = async (endpoint, body) => (await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'test-secret' }, body: body ? JSON.stringify(body) : undefined })).json();
  assert.equal((await fetch(base + 'extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  await call('config', { saveDir: path.join(dir, 'out'), headers: JSON.stringify({ cookie: 'page-cookie' }) });
  const result = await call('extract', { urls: [origin + '/watch'], deep: 1 });
  assert.equal(result.code, 0); assert.equal(result.data.items.length, 4);
  const chosen = result.data.items.filter(item => item.type === 'file');
  assert.equal((await call('download', { list: chosen.map(item => ({ url: item.url, sourceUrl: item.source, headerSourceUrl: item.credentialSource, type: item.type })) })).code, 0);
  let tasks;
  for (let i = 0; i < 100; i++) { tasks = (await call('tasks')).data; if (Object.values(tasks).every(task => ['done', 'error'].includes(task.status))) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(Object.keys(tasks).length, 3);
  for (const task of Object.values(tasks)) assert.equal(task.status, 'done', task.errmsg);
  assert.equal(requests.length, 3);
  for (const request of requests) { assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.referer, request.url === '/iframe.vtt' ? cdn + '/player' : origin + '/watch'); }
  const legacy = await call('getM3u8Urls', { url: origin + '/watch', deep: 0 });
  assert.equal(legacy.data.length, 3); assert.ok(Array.isArray(legacy.data[0]));
  assert.notEqual((await call('extract', { urls: [origin], deep: 9 })).code, 0);
  assert.ok((await call('platforms')).data.includes('douyin'));
});

test('platform download keeps source task identity, strips CDN credentials and supports pause/resume cache', async t => {
  const dir = await temporary(t);
  const originalParse = VideoParser.parse;
  t.after(() => { VideoParser.parse = originalParse; });
  const bytes = Buffer.alloc(3 * 1024 * 1024, 75);
  const ranges = [];
  const origin = await serve(t, (req, res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.referer, 'https://www.douyin.com/video/123');
    let position = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0); ranges.push(position);
    res.writeHead(position ? 206 : 200, { etag: '"v1"', 'content-length': bytes.length - position,
      ...(position ? { 'content-range': `bytes ${position}-${bytes.length - 1}/${bytes.length}` } : {}) });
    const timer = setInterval(() => { res.write(bytes.subarray(position, position += 65536)); if (position >= bytes.length) { clearInterval(timer); res.end(); } }, 20);
    res.once('close', () => clearInterval(timer));
  });
  VideoParser.parse = async () => ({ code: 0, data: { title: '测试分享视频', url: origin + '/video.mp4' } });
  const url = 'https://www.douyin.com/video/123';
  const options = { saveDir: dir, cacheDir: path.join(dir, 'cache'), headers: { Cookie: 'platform-cookie', Authorization: 'platform-token' } };
  const paused = await downloadResource(url, { ...options, onProgress: (_n, _total, _item, stats) => { assert.equal(stats.url, url); if (stats.downloadedSize > 0) m3u8DLStop(url); } });
  assert.equal(paused.paused, true);
  assert.ok((await fs.stat(path.join(dir, 'cache', md5(url), 'download.part'))).size > 0);
  const complete = await downloadResource(url, options);
  assert.equal(complete.errmsg, undefined); assert.equal(complete.stats.url, url);
  assert.ok(ranges[1] > 0); assert.deepEqual(await fs.readFile(complete.filepath), bytes);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DLServer } = require('../cjs/server/download-server.js');
const { m3u8Download } = require('../cjs/lib/m3u8-download.js');

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cat-catch-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Cat-Catch accepts authenticated single and batch sends, and uses only captured task headers', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);
  const received = new Map();
  const source = await serve(t, (req, res) => {
    received.set(req.url, req.headers);
    if (req.url.startsWith('/track')) {
      res.setHeader('content-type', 'text/vtt');
      res.end('WEBVTT\n');
    } else res.end('video bytes');
  });
  server = new DLServer({ port: 0, cacheDir: path.join(dir, 'cache'), token: 'fixture-secret' });
  await server.ready;
  const api = `http://127.0.0.1:${server.server.address().port}/api/`;
  const call = (endpoint, data, token = 'fixture-secret') => fetch(api + endpoint, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  await call('config', { saveDir: dir, headers: { Cookie: 'global-cookie', Origin: 'https://global.example' } });
  const video = {
    url: source + '/video.mp4', fullFileName: 'sample.mp4', ext: 'mp4',
    cookie: 'media-session="quoted value"', origin: 'https://player.example', referer: 'https://player.example/watch',
    userAgent: 'CatCatch fixture',
  };
  assert.equal((await call('cat-catch', { action: 'catch', data: video }, '')).status, 401);
  assert.equal((await call('cat-catch', { action: 'addKey', data: 'not a resource' })).status, 400);
  assert.equal((await call('cat-catch', { action: 'catch', data: [video, { url: 'file:///invalid' }] })).status, 400);
  assert.equal((await call('cat-catch', { action: 'catch', data: { ...video, cookie: 'bad\r\nvalue' } })).status, 400);
  assert.deepEqual((await (await call('tasks')).json()).data, {});
  assert.deepEqual((await (await call('cat-catch', { action: 'catch', data: video, tabId: '3' })).json()).data, { added: 1, skipped: 0 });
  const subtitles = [
    { url: source + '/track?id=1', type: 'text/vtt', requestHeaders: [{ name: 'Referer', value: 'https://player.example/watch' }] },
    { url: source + '/track?id=2', name: 'sample.zh.vtt', requestHeaders: { Cookie: 'subtitle-cookie' } },
  ];
  assert.deepEqual((await (await call('cat-catch', { action: 'catch', data: subtitles })).json()).data, { added: 2, skipped: 0 });
  let tasks;
  for (let i = 0; i < 100; i++) {
    tasks = Object.values((await (await call('tasks')).json()).data);
    if (tasks.length === 3 && tasks.every(task => ['done', 'error'].includes(task.status))) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(tasks.length, 3);
  for (const task of tasks) assert.equal(task.status, 'done', task.errmsg);
  assert.deepEqual(tasks.map(task => task.filename).sort(), ['sample.mp4', 'sample.zh.vtt', 'track.vtt']);
  assert.equal(received.get('/video.mp4').cookie, video.cookie);
  assert.equal(received.get('/video.mp4').origin, video.origin);
  assert.equal(received.get('/video.mp4').referer, video.referer);
  assert.equal(received.get('/video.mp4')['user-agent'], video.userAgent);
  assert.equal(received.get('/video.mp4').authorization, undefined);
  assert.equal(received.get('/track?id=1').cookie, undefined);
  assert.equal(received.get('/track?id=1').origin, undefined);
  assert.equal(received.get('/track?id=1').referer, video.referer);
  assert.equal(received.get('/track?id=2').cookie, 'subtitle-cookie');
  assert.deepEqual((await (await call('cat-catch', { action: 'catch', data: video })).json()).data, { added: 0, skipped: 1 });
});

test('remote HLS scopes credentials for child playlists, init segments, AES keys and media segments', async t => {
  const dir = await temporary(t);
  const key = Buffer.alloc(16, 42);
  const segment = Buffer.alloc(128, 71);
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(segment), cipher.final()]);
  const seen = new Map();
  const cdn = await serve(t, (req, res) => {
    seen.set(req.url, req.headers);
    switch (req.url) {
      case '/child.m3u8':
        res.end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\npart.m4s\n#EXT-X-ENDLIST\n');
        break;
      case '/init.mp4': res.end(Buffer.from('0000ftypisom')); break;
      case '/key': res.end(key); break;
      case '/part.m4s': res.end(encrypted); break;
      default: res.writeHead(404).end();
    }
  });
  const source = await serve(t, (req, res) => {
    seen.set(req.url, req.headers);
    res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${cdn}/child.m3u8\n`);
  });
  const result = await m3u8Download(source + '/main.m3u8', {
    saveDir: dir, cacheDir: path.join(dir, 'cache'), convert: false,
    headers: { Cookie: 'media-cookie', Authorization: 'media-auth', Referer: 'https://player.example/watch' },
  });
  assert.equal(result.errmsg, undefined);
  assert.equal(result.stats.tsSuccess, 1);
  assert.deepEqual(await fs.readFile(result.m3u8Info.data[0].tsOut), segment);
  assert.equal(seen.get('/main.m3u8').cookie, 'media-cookie');
  assert.equal(seen.get('/main.m3u8').authorization, 'media-auth');
  for (const resource of ['/child.m3u8', '/init.mp4', '/key', '/part.m4s']) {
    assert.equal(seen.get(resource).cookie, undefined);
    assert.equal(seen.get(resource).authorization, undefined);
    assert.equal(seen.get(resource).referer, 'https://player.example/watch');
  }
});

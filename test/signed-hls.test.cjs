const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { signedHlsProxy } = require('../cjs/lib/signed-hls-proxy.js');
const { VideoParser } = require('../cjs/video-parser/index.js');

test('signed HLS proxy rewrites manifests and shares a refresh after concurrent 403 responses', async t => {
  let refreshes = 0;
  let valid = 'initial';
  const seen = [];
  const remote = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    seen.push(url);
    if (url.searchParams.get('token') !== valid) { res.writeHead(403).end(); return; }
    if (url.pathname === '/asset/master.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nindex.m3u8?lang=zh\n');
    } else if (url.pathname === '/asset/index.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1,\na.ts?track=1\n#EXTINF:1,\nb.ts?track=2\n#EXT-X-ENDLIST\n');
    } else res.end(url.pathname.endsWith('key.bin') ? Buffer.alloc(16, 1) : url.pathname);
  });
  await new Promise(done => remote.listen(0, '127.0.0.1', done));
  t.after(() => { remote.closeAllConnections(); return new Promise(done => remote.close(done)); });
  const origin = `http://127.0.0.1:${remote.address().port}`;
  const master = token => `${origin}/asset/master.m3u8?token=${token}&expires=${Math.floor(Date.now() / 1000) + 60}`;
  const proxy = await signedHlsProxy(master('initial'), async () => {
    refreshes++;
    await new Promise(done => setTimeout(done, 30));
    return master(valid);
  }, {}, new AbortController().signal);
  t.after(() => proxy.close());
  const list = await (await fetch(proxy.url)).text();
  const child = list.split('\n').find(line => line.startsWith('http'));
  const media = await (await fetch(child)).text();
  const urls = media.split('\n').filter(line => line.startsWith('http'));
  const key = /URI="([^"]+)"/.exec(media)[1];
  valid = 'updated';
  const results = await Promise.all(urls.map(async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return response.text();
  }));
  assert.equal(refreshes, 1);
  assert.deepEqual(results, ['/asset/a.ts', '/asset/b.ts']);
  assert.equal((await (await fetch(key)).arrayBuffer()).byteLength, 16);
  assert.ok(seen.some(url => url.pathname.endsWith('index.m3u8') && url.searchParams.get('lang') === 'zh'));
  assert.ok(seen.some(url => url.pathname.endsWith('b.ts') && url.searchParams.get('track') === '2' && url.searchParams.get('token') === valid));
  assert.equal((await (await fetch(child)).text()), media);
});

test('Javrate parser uses same-origin player HTML or the signed-address endpoint and reports missing data', async () => {
  const page = 'https://www.javrate.com/movie/detail/test.html';
  const media = 'https://cloud-hot-1.avking.xyz/video/playlist.m3u8?token=fixture&expires=1900000000';
  const calls = [];
  const context = { request: async (url, options) => {
    calls.push({ url, options });
    if (url === page) return { url, text: '<title>测试视频</title><iframe src="/player/v2?payload=fixture"></iframe>' };
    return { url, text: `var src="${media}"` };
  } };
  const parsed = await VideoParser.parse(page, undefined, context);
  assert.equal(parsed.code, 0, parsed.message);
  assert.equal(parsed.data.url, media);
  assert.equal(parsed.data.title, '测试视频');
  assert.equal(VideoParser.getPlatform(page).platform, 'javrate');
  assert.equal(VideoParser.getPlatform('https://javrate.com.other.test/').platform, 'unknown');
  const apiContext = { request: async (url, options) => {
    if (url === page) return { url, text: '<title>测试</title><script type="application/ld+json">{"contentUrl":"https://videocdn.avking.xyz/video/playlist.m3u8"}</script>' };
    assert.equal(url, 'https://www.javrate.com/api/bunnytoken/generate');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).m3u8Url, 'https://videocdn.avking.xyz/video/playlist.m3u8');
    return { url, text: JSON.stringify({ success: true, data: { signedUrl: media } }) };
  } };
  assert.equal((await VideoParser.parse(page, undefined, apiContext)).data.url, media);
  const missing = await VideoParser.parse(page, undefined, { request: async url => ({ url, text: '<html></html>' }) });
  assert.notEqual(missing.code, 0);
  assert.match(missing.message, /未找到播放地址/);
});

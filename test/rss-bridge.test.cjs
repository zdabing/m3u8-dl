const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DLServer } = require('../cjs/server/download-server.js');

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rss-bridge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function rawGet(baseUrl, urlPath) {
  const parsed = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: parsed.hostname, port: parsed.port, path: urlPath, method: 'GET' }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function createMockSources(t) {
  let upstreamOrigin = '';
  const cdnSeen = [];
  const segPayload = Buffer.from('0123456789abcdef');
  const keyPayload = Buffer.alloc(16, 0xab);

  const cdnOrigin = await serve(t, (req, res) => {
    cdnSeen.push({ url: req.url, headers: req.headers });
    if (req.headers.referer !== `${upstreamOrigin}/`) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Missing Referer');
      return;
    }
    if (req.url === '/videos/abc123/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/videos/abc123/enc.key') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(keyPayload.length) });
      res.end(keyPayload);
      return;
    }
    if (req.url === '/videos/abc123/seg0.ts') {
      const range = req.headers.range;
      if (range === 'bytes=0-7') {
        const slice = segPayload.subarray(0, 8);
        res.writeHead(206, {
          'content-type': 'video/mp2t',
          'content-range': `bytes 0-7/${segPayload.length}`,
          'content-length': String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(segPayload.length) });
      res.end(segPayload);
      return;
    }
    res.writeHead(404).end();
  });

  upstreamOrigin = await serve(t, (req, res) => {
    if (req.url === '/rss.xml') {
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mock Feed</title>
    <link>${upstreamOrigin}/</link>
    <description>Fixture</description>
    <item>
      <title>测试视频 01</title>
      <link>${upstreamOrigin}/v/abc123/</link>
      <guid>${upstreamOrigin}/v/abc123/</guid>
      <pubDate>Fri, 20 Nov 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`);
      return;
    }
    if (req.url === '/v/abc123/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>测试视频 01</title></head><body><script>const src="${cdnOrigin}/videos/abc123/index.m3u8";</script></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });

  return { upstreamOrigin, cdnOrigin, cdnSeen, keyPayload, segPayload };
}

test('RSS bridge toggles on/off via config and proxies Referer-protected HLS assets', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);
  const { upstreamOrigin, cdnOrigin, cdnSeen, keyPayload, segPayload } = await createMockSources(t);

  server = new DLServer({ port: 0, cacheDir: path.join(dir, 'cache') });
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}`;

  // Test 1: Disabled by default
  const disabledRes = await fetch(`${base}/rss-bridge/rss.xml`);
  assert.equal(disabledRes.status, 404);

  // Test 2: Enable via POST /api/config
  const cfgRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeEnabled: true,
      rssBridgeFeedUrl: `${upstreamOrigin}/rss.xml`,
      rssBridgeLimit: 10,
      rssBridgeCacheTtl: 60,
    }),
  });
  assert.equal(cfgRes.status, 200);

  const rssRes = await fetch(`${base}/rss-bridge/rss.xml`);
  assert.equal(rssRes.status, 200);
  assert.match(rssRes.headers.get('content-type') || '', /rss\+xml/);
  const xml = await rssRes.text();
  assert.match(xml, /<rss version="2\.0">/);

  const encMatch = /<enclosure url="([^"]+)" type="application\/vnd\.apple\.mpegurl" length="0" \/>/.exec(xml);
  assert.ok(encMatch, 'Expected proxied enclosure URL');
  const proxyM3u8Url = encMatch[1];
  assert.ok(proxyM3u8Url.startsWith(`${base}/rss-bridge/hls/`));
  assert.ok(proxyM3u8Url.endsWith('.m3u8'));

  // Fetch proxied playlist, key, and range segment with NO Referer header
  const m3u8Res = await fetch(proxyM3u8Url);
  assert.equal(m3u8Res.status, 200);
  assert.match(m3u8Res.headers.get('content-type') || '', /mpegurl/);
  const playlist = await m3u8Res.text();
  assert.match(playlist, /^#EXTM3U/);
  assert.match(playlist, /URI="enc\.key"/);
  assert.match(playlist, /seg0\.ts/);

  const keyRes = await fetch(new URL('enc.key', proxyM3u8Url));
  assert.equal(keyRes.status, 200);
  assert.deepEqual(Buffer.from(await keyRes.arrayBuffer()), keyPayload);

  const segRes = await fetch(new URL('seg0.ts', proxyM3u8Url), { headers: { range: 'bytes=0-7' } });
  assert.equal(segRes.status, 206);
  assert.equal(segRes.headers.get('content-range'), `bytes 0-7/${segPayload.length}`);
  assert.deepEqual(Buffer.from(await segRes.arrayBuffer()), segPayload.subarray(0, 8));
  assert.ok(cdnSeen.length >= 3);
  assert.ok(cdnSeen.every(entry => entry.headers.referer === `${upstreamOrigin}/`));
  assert.ok(cdnSeen.every(entry => !entry.headers.authorization));

  // Security guards: path traversal -> 400, cross-origin hls-sub -> 403
  const idMatch = /\/rss-bridge\/hls\/([0-9a-f]{16})\//.exec(proxyM3u8Url);
  assert.ok(idMatch);
  const itemId = idMatch[1];
  assert.equal(await rawGet(base, `/rss-bridge/hls/${itemId}/../../etc/passwd`), 400);
  const ssrfRes = await fetch(`${base}/rss-bridge/hls-sub/${itemId}?u=${encodeURIComponent(`${upstreamOrigin}/rss.xml`)}`);
  assert.equal(ssrfRes.status, 403);
  assert.ok(cdnOrigin);

  // Test 3: Disable via POST /api/config -> 404 immediately
  const disableCfgRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rssBridgeEnabled: false }),
  });
  assert.equal(disableCfgRes.status, 200);
  const afterDisableRes = await fetch(`${base}/rss-bridge/rss.xml`);
  assert.equal(afterDisableRes.status, 404);
});

test('RSS bridge enforces token auth and propagates query token into proxied playlists', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);
  const { upstreamOrigin, keyPayload } = await createMockSources(t);

  const prevEnv = process.env.DS_RSS_BRIDGE_ENABLED;
  process.env.DS_RSS_BRIDGE_ENABLED = 'true';
  try {
    server = new DLServer({ port: 0, cacheDir: path.join(dir, 'cache'), token: 'secret-pass' });
  } finally {
    if (prevEnv === undefined) delete process.env.DS_RSS_BRIDGE_ENABLED;
    else process.env.DS_RSS_BRIDGE_ENABLED = prevEnv;
  }
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}`;

  const updateCfg = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { authorization: 'secret-pass', 'content-type': 'application/json' },
    body: JSON.stringify({ rssBridgeFeedUrl: `${upstreamOrigin}/rss.xml` }),
  });
  assert.equal(updateCfg.status, 200);

  // Unauthenticated request -> 401
  assert.equal((await fetch(`${base}/rss-bridge/rss.xml`)).status, 401);

  // Query-token request -> 200 and propagates ?token=secret-pass
  const rssRes = await fetch(`${base}/rss-bridge/rss.xml?token=secret-pass`);
  assert.equal(rssRes.status, 200);
  const xml = await rssRes.text();
  const encMatch = /<enclosure url="([^"]+)"/.exec(xml);
  assert.ok(encMatch);
  const proxyM3u8Url = encMatch[1];
  assert.match(proxyM3u8Url, /\?token=secret-pass$/);

  const m3u8Res = await fetch(proxyM3u8Url);
  assert.equal(m3u8Res.status, 200);
  const playlist = await m3u8Res.text();
  assert.match(playlist, /URI="enc\.key\?token=secret-pass"/);
  assert.match(playlist, /seg0\.ts\?token=secret-pass/);

  const keyRes = await fetch(new URL('enc.key?token=secret-pass', proxyM3u8Url));
  assert.equal(keyRes.status, 200);
  assert.deepEqual(Buffer.from(await keyRes.arrayBuffer()), keyPayload);

  // Direct segment without token still rejected -> 401
  const noTokenKey = new URL('enc.key', proxyM3u8Url);
  noTokenKey.search = '';
  assert.equal((await fetch(noTokenKey)).status, 401);
});

test('RSS bridge supports multi-feed RSS + HTML list mode with per-feed Referer isolation and config validation', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);

  const srcA = await createMockSources(t);

  let upstreamB = '';
  const cdnBSeen = [];
  const keyB = Buffer.alloc(16, 0xcd);
  const segB = Buffer.from('ts-payload-from-cdn-b');
  const cdnB = await serve(t, (req, res) => {
    cdnBSeen.push({ url: req.url, referer: req.headers.referer });
    if (req.headers.referer !== `${upstreamB}/`) {
      res.writeHead(403).end('Forbidden Referer');
      return;
    }
    if (req.url === '/b/ep1/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/b/ep1/enc.key') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(keyB);
      return;
    }
    if (req.url === '/b/ep1/seg0.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' }).end(segB);
      return;
    }
    res.writeHead(404).end();
  });

  upstreamB = await serve(t, (req, res) => {
    if (req.url === '/list') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>HTML 站点B</title></head><body>
        <a href="/about">关于</a>
        <a href="/style.css">样式</a>
        <a href="/watch/ep1">剧集 01</a>
      </body></html>`);
      return;
    }
    if (req.url === '/watch/ep1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><video src="${cdnB}/b/ep1/index.m3u8"></video></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });

  server = new DLServer({ port: 0, cacheDir: path.join(dir, 'cache') });
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}`;

  const saveRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeEnabled: true,
      rssBridgeFeeds: [
        {
          id: 'site-rss',
          name: '站点 A (RSS)',
          enabled: true,
          mode: 'rss',
          url: `${srcA.upstreamOrigin}/rss.xml`,
          itemPattern: '',
          referer: '',
          limit: 10,
          cacheTtl: 60,
        },
        {
          id: 'site-html',
          name: '站点 B (HTML)',
          enabled: true,
          mode: 'html',
          url: `${upstreamB}/list`,
          itemPattern: '/watch/',
          referer: '',
          limit: 10,
          cacheTtl: 60,
        },
        {
          id: 'disabled-feed',
          name: '已停用源',
          enabled: false,
          mode: 'rss',
          url: `${srcA.upstreamOrigin}/rss.xml`,
          itemPattern: '',
          referer: '',
          limit: 5,
          cacheTtl: 60,
        },
      ],
    }),
  });
  assert.equal(saveRes.status, 200);

  // Feed A (RSS)
  const resA = await fetch(`${base}/rss-bridge/feeds/site-rss.xml`);
  assert.equal(resA.status, 200);
  const xmlA = await resA.text();
  const encA = /<enclosure url="([^"]+)"/.exec(xmlA)?.[1];
  assert.ok(encA);
  assert.equal((await fetch(encA)).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(new URL('enc.key', encA))).arrayBuffer()), srcA.keyPayload);
  assert.ok(srcA.cdnSeen.every(entry => entry.headers.referer === `${srcA.upstreamOrigin}/`));

  // Feed B (HTML list mode)
  const resB = await fetch(`${base}/rss-bridge/feeds/site-html.xml`);
  assert.equal(resB.status, 200);
  const xmlB = await resB.text();
  const itemsB = xmlB.match(/<item>/g) || [];
  assert.equal(itemsB.length, 1);
  assert.match(xmlB, /<title>剧集 01<\/title>/);
  assert.doesNotMatch(xmlB, /关于/);

  const encB = /<enclosure url="([^"]+)"/.exec(xmlB)?.[1];
  assert.ok(encB);
  assert.equal((await fetch(encB)).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(new URL('enc.key', encB))).arrayBuffer()), keyB);
  assert.deepEqual(Buffer.from(await (await fetch(new URL('seg0.ts', encB))).arrayBuffer()), segB);
  assert.ok(cdnBSeen.length >= 3);
  assert.ok(cdnBSeen.every(entry => entry.referer === `${upstreamB}/`));

  // Disabled & unknown feeds return 404
  assert.equal((await fetch(`${base}/rss-bridge/feeds/disabled-feed.xml`)).status, 404);
  assert.equal((await fetch(`${base}/rss-bridge/feeds/unknown-feed.xml`)).status, 404);

  // Health reports all configured feeds
  const health = await (await fetch(`${base}/rss-bridge/health`)).json();
  assert.equal(health.feeds.length, 3);

  // Validation rejects duplicate case-insensitive IDs and invalid IDs/URLs
  const dupRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeFeeds: [
        { id: 'Site-A', name: 'A1', enabled: true, mode: 'rss', url: `${srcA.upstreamOrigin}/rss.xml`, limit: 10, cacheTtl: 60 },
        { id: 'site-a', name: 'A2', enabled: true, mode: 'rss', url: `${srcA.upstreamOrigin}/rss.xml`, limit: 10, cacheTtl: 60 },
      ],
    }),
  });
  assert.equal(dupRes.status, 400);

  const badIdRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeFeeds: [{ id: 'bad/id', name: 'Bad', enabled: true, mode: 'rss', url: `${srcA.upstreamOrigin}/rss.xml`, limit: 10, cacheTtl: 60 }],
    }),
  });
  assert.equal(badIdRes.status, 400);

  const badUrlRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeFeeds: [{ id: 'ok-id', name: 'BadUrl', enabled: true, mode: 'html', url: 'ftp://example.com/list', limit: 10, cacheTtl: 60 }],
    }),
  });
  assert.equal(badUrlRes.status, 400);
});

test('RSS bridge supports unlimited (0) and >50 feeds via lazy on-demand detail resolution', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);

  let upstreamOrigin = '';
  const detailRequests = new Map();
  const cdnSeen = [];
  const keyPayload = Buffer.alloc(16, 0xef);
  const segPayload = Buffer.from('lazy-segment-bytes');

  const cdnOrigin = await serve(t, (req, res) => {
    cdnSeen.push({ url: req.url, referer: req.headers.referer });
    if (req.headers.referer !== `${upstreamOrigin}/`) {
      res.writeHead(403).end('Missing Referer');
      return;
    }
    if (/^\/videos\/item-\d+\/index\.m3u8$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (/^\/videos\/item-\d+\/enc\.key$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(keyPayload);
      return;
    }
    if (/^\/videos\/item-\d+\/seg0\.ts$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'video/mp2t' }).end(segPayload);
      return;
    }
    res.writeHead(404).end();
  });

  upstreamOrigin = await serve(t, (req, res) => {
    if (req.url === '/rss.xml') {
      const itemsXml = Array.from({ length: 60 }, (_, idx) => {
        const n = idx + 1;
        return `<item><title>视频 ${n}</title><link>${upstreamOrigin}/v/item-${n}</link><guid>${upstreamOrigin}/v/item-${n}</guid></item>`;
      }).join('\n');
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Large Feed</title><link>${upstreamOrigin}/</link><description>Large</description>${itemsXml}</channel></rss>`);
      return;
    }
    const detailMatch = /^\/v\/(item-\d+)$/.exec(req.url);
    if (detailMatch) {
      const slug = detailMatch[1];
      detailRequests.set(slug, (detailRequests.get(slug) || 0) + 1);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><script>const url="${cdnOrigin}/videos/${slug}/index.m3u8";</script></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });

  server = new DLServer({ port: 0, cacheDir: path.join(dir, 'cache') });
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}`;

  const saveZeroRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeEnabled: true,
      rssBridgeFeeds: [
        {
          id: 'large',
          name: '大站订阅',
          enabled: true,
          mode: 'rss',
          url: `${upstreamOrigin}/rss.xml`,
          itemPattern: '',
          referer: '',
          limit: 0,
          cacheTtl: 60,
        },
      ],
    }),
  });
  assert.equal(saveZeroRes.status, 200);

  // Returns all 60 items without scraping all 60 detail pages upfront
  const xmlRes = await fetch(`${base}/rss-bridge/feeds/large.xml`);
  assert.equal(xmlRes.status, 200);
  const xml = await xmlRes.text();
  const enclosures = [...xml.matchAll(/<enclosure url="([^"]+)" type="application\/vnd\.apple\.mpegurl" length="0" \/>/g)].map(m => m[1]);
  assert.equal(enclosures.length, 60);
  assert.equal(detailRequests.size, 0);

  // Fetch item #55 -> triggers on-demand detail resolution + Referer proxy
  const item55Url = enclosures[54];
  const m3u8Res = await fetch(item55Url);
  assert.equal(m3u8Res.status, 200);
  const playlist = await m3u8Res.text();
  assert.match(playlist, /^#EXTM3U/);
  assert.match(playlist, /URI="enc\.key"/);
  assert.match(playlist, /seg0\.ts/);
  assert.equal(detailRequests.get('item-55'), 1);

  assert.deepEqual(Buffer.from(await (await fetch(new URL('enc.key', item55Url))).arrayBuffer()), keyPayload);
  assert.deepEqual(Buffer.from(await (await fetch(new URL('seg0.ts', item55Url))).arrayBuffer()), segPayload);
  assert.ok(cdnSeen.length >= 3);
  assert.ok(cdnSeen.every(entry => entry.referer === `${upstreamOrigin}/`));

  // Subsequent fetch uses cached detail rather than re-fetching HTML
  assert.equal((await fetch(item55Url)).status, 200);
  assert.equal(detailRequests.get('item-55'), 1);

  // Accepts >50 limits and rejects negative limits
  const save200Res = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeFeeds: [{ id: 'large', name: '大站订阅', enabled: true, mode: 'rss', url: `${upstreamOrigin}/rss.xml`, limit: 200, cacheTtl: 60 }],
    }),
  });
  assert.equal(save200Res.status, 200);

  const badNegRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rssBridgeFeeds: [{ id: 'large', name: '大站订阅', enabled: true, mode: 'rss', url: `${upstreamOrigin}/rss.xml`, limit: -1, cacheTtl: 60 }],
    }),
  });
  assert.equal(badNegRes.status, 400);
});

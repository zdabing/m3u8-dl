const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { createCipheriv } = require('node:crypto');
const { formatHeaders, buildRequestHeaders, normalizeDownloadUrl, getRetry } = require('../cjs/lib/utils.js');
const { m3u8Download } = require('../cjs/lib/m3u8-download.js');
const { m3u8Convert, isSupportFfmpeg } = require('../cjs/lib/m3u8-convert.js');
const { runMediaProcess } = require('../cjs/lib/merge-process.js');
const { DLServer } = require('../cjs/server/download-server.js');

async function temporary(t) {
  const root = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root, 'm3u8-dl-test-'));
  assert.ok(dir.startsWith(root + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function media(t, fmp4 = false) {
  if (!await isSupportFfmpeg()) { t.skip('FFmpeg is required for media integration tests'); return null; }
  const dir = await temporary(t);
  const list = path.join(dir, 'index.m3u8');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', ...(fmp4 ? ['-hls_segment_type', 'fmp4'] : []), list], { windowsHide: true, cwd: dir });
  return { dir, list, content: await fs.readFile(list, 'utf8') };
}
function mediaHandler(fixture, record = []) {
  return async (req, res) => {
    record.push({ path: req.url, headers: req.headers });
    if (req.headers.referer !== `http://${req.headers.host}/`) { res.writeHead(404).end('Referer required'); return; }
    try {
      const file = req.url.split('?')[0] === '/index.txt' ? fixture.list : path.join(fixture.dir, path.basename(req.url));
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  };
}
function probe(file) { return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8', windowsHide: true })); }

test('automatic headers, overrides, formats and markdown URL cleanup', () => {
  const url = 'https://example.com/video/index.txt';
  assert.equal(buildRequestHeaders(url).referer, 'https://example.com/');
  assert.match(buildRequestHeaders(url)['user-agent'], /Mozilla/);
  assert.equal(buildRequestHeaders(url, 'Referer: https://source.example/watch').referer, 'https://source.example/watch');
  assert.equal(buildRequestHeaders(url, { Referer: '' }).referer, undefined);
  assert.deepEqual(formatHeaders('Cookie: a=b,c=d\nX-Source: demo'), { cookie: 'a=b,c=d', 'x-source': 'demo' });
  assert.deepEqual(formatHeaders('{"Referer":"https://x.test/","Host":"bad"}'), { referer: 'https://x.test/' });
  assert.throws(() => formatHeaders('wrong line'), /请求头/);
  assert.throws(() => formatHeaders('{"X-Test":"a\\r\\nb"}'), /无效/);
  assert.equal(normalizeDownloadUrl('https://x.test/name\\_,l,.urlset/index.txt'), 'https://x.test/name_,l,.urlset/index.txt');
});

test('HTTP errors retain status and are not parsed as playlists', async t => {
  let attempts = 0;
  const origin = await serve(t, (_req, res) => { attempts++; res.writeHead(404).end('no'); });
  await assert.rejects(getRetry(origin + '/gone'), /HTTP 404.*Referer/);
  assert.equal(attempts, 1);
});

test('cross-origin redirects strip cookies and authorization', async t => {
  let captured;
  const target = await serve(t, (req, res) => { captured = req.headers; res.end('ok'); });
  const origin = await serve(t, (_req, res) => res.writeHead(302, { location: target }).end());
  await getRetry(origin, { Cookie: 'fixture', Authorization: 'fixture' });
  assert.equal(captured.cookie, undefined); assert.equal(captured.authorization, undefined);
});

test('aborting a stalled request releases it promptly', async t => {
  const origin = await serve(t, () => {});
  const controller = new AbortController();
  const operation = getRetry(origin, {}, 3, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(operation, /abort/i);
});

for (const fmp4 of [false, true]) test(`${fmp4 ? 'fMP4' : 'TS'} download and merge with automatic Referer`, async t => {
  const fixture = await media(t, fmp4); if (!fixture) return;
  const record = [];
  const origin = await serve(t, mediaHandler(fixture, record));
  const phases = [];
  const result = await m3u8Download(origin + '/index.txt', { saveDir: fixture.dir, cacheDir: path.join(fixture.dir, 'cache'), filename: 'final', onProgress: (_a, _b, _c, stats) => phases.push(stats.phase) });
  assert.equal(result.errmsg, undefined); assert.ok(result.filepath?.endsWith('.mp4'));
  assert.equal(result.stats.progress, 100); assert.ok(phases.includes('merging'));
  const parsed = probe(result.filepath);
  assert.ok(Number(parsed.format.duration) > 2.8);
  assert.ok(parsed.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(parsed.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(record.length >= 4);
  assert.ok(record.every(item => item.headers.referer === origin + '/'));
  assert.equal((await fs.readdir(fixture.dir)).some(name => name.includes('.part')), false);
});

test('AES-128 derives the IV from each media sequence', async t => {
  const fixture = await media(t); if (!fixture) return;
  const key = Buffer.from('0123456789abcdef');
  const names = fixture.content.split('\n').filter(line => line && !line.startsWith('#'));
  const sequence = 7;
  let keyRequests = 0;
  for (const [index, name] of names.entries()) {
    const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(sequence + index), 8);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const data = await fs.readFile(path.join(fixture.dir, name));
    await fs.writeFile(path.join(fixture.dir, name), Buffer.concat([cipher.update(data), cipher.final()]));
  }
  const content = fixture.content.replace('#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-MEDIA-SEQUENCE:${sequence}`).replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:');
  await fs.writeFile(fixture.list, content);
  const handler = mediaHandler(fixture);
  const origin = await serve(t, (req, res) => { if (req.url === '/key') { keyRequests++; res.end(key); } else void handler(req, res); });
  const result = await m3u8Download(origin + '/index.txt', { filename: 'encrypted', saveDir: fixture.dir, cacheDir: path.join(fixture.dir, 'cache') });
  assert.equal(result.errmsg, undefined); assert.equal(keyRequests, 1);
  assert.ok(Number(probe(result.filepath).format.duration) > 2.8);
});

test('pause preserves downloaded fragments and resume reuses them', async t => {
  const fixture = await media(t); if (!fixture) return;
  const record = [];
  const origin = await serve(t, mediaHandler(fixture, record));
  const controller = new AbortController();
  const options = { filename: 'resumed', saveDir: fixture.dir, cacheDir: path.join(fixture.dir, 'cache'), threadNum: 1, delCache: false };
  const first = await m3u8Download(origin + '/index.txt', { ...options, signal: controller.signal, onProgress: (_a, _b, _c, stats) => { if (stats.tsSuccess === 1) controller.abort(); } });
  assert.equal(first.paused, true); assert.equal(first.filepath, undefined);
  const firstSegment = record.find(item => item.path.endsWith('.ts')).path;
  const second = await m3u8Download(origin + '/index.txt', options);
  assert.equal(second.errmsg, undefined); assert.ok(second.filepath);
  assert.equal(record.filter(item => item.path === firstSegment).length, 1);
});

test('merge watchdog terminates a hung subprocess', async () => {
  const start = Date.now();
  await assert.rejects(runMediaProcess(process.execPath, ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], Readable.from(['input']), { idleTimeout: .2 }), /无进展/);
  assert.ok(Date.now() - start < 3000);
});

test('merge abort and continuously drained stderr', async () => {
  await runMediaProcess(process.execPath, ['-e', 'process.stdin.resume(); process.stderr.write("x".repeat(2000000)); process.stdin.on("end",()=>process.exit(0));'], Readable.from(['input']), { idleTimeout: 5 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(runMediaProcess(process.execPath, ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'], Readable.from(['input']), { idleTimeout: 5, signal: controller.signal }), /abort/i);
});

test('failed merge never publishes a partial output', async t => {
  if (!await isSupportFfmpeg()) { t.skip(); return; }
  const dir = await temporary(t); const segment = path.join(dir, 'bad.ts');
  await fs.writeFile(segment, Buffer.alloc(1000));
  await assert.rejects(m3u8Convert({ saveDir: dir, filename: 'bad.mp4', mergeTimeout: 5 }, [{ tsOut: segment, uri: 'x.ts', index: 0, duration: 1 }]), /FFmpeg/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['bad.ts']);
});

test('server auth, lifecycle, file saving and removed player routes', async t => {
  let server;
  t.after(() => server?.close());
  const fixture = await media(t); if (!fixture) return;
  const origin = await serve(t, mediaHandler(fixture));
  const dir = await temporary(t);
  server = new DLServer({ port: 0, cacheDir: dir, token: 'fixture-password' });
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}`;
  assert.equal((await fetch(base + '/api/tasks')).status, 401);
  for (const endpoint of ['/play.html', '/localplay/foo.ts', '/m3u8-capture.user.js']) assert.equal((await fetch(base + endpoint)).status, 404);
  const request = (endpoint, body) => fetch(base + '/api/' + endpoint, { method: body ? 'POST' : 'GET', headers: { authorization: 'fixture-password', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const invalid = await request('config', { maxDownloads: 0 }); assert.equal(invalid.status, 400);
  assert.equal((await request('config', { saveDir: fixture.dir, maxDownloads: 1 })).status, 200);
  const url = origin + '/index.txt';
  assert.equal((await request('download', { list: [{ url, filename: 'from-server' }] })).status, 200);
  let task;
  const start = Date.now();
  do {
    const response = await (await request('tasks')).json(); task = response.data[url];
    if (task.status === 'done' || task.status === 'error') break;
    await new Promise(done => setTimeout(done, 50));
  } while (Date.now() - start < 10000);
  assert.equal(task.status, 'done', task.errmsg);
  const file = await request('file?url=' + encodeURIComponent(url));
  assert.equal(file.status, 200); assert.match(file.headers.get('content-disposition'), /attachment/);
  await file.arrayBuffer();
  assert.equal((await request('delete', { urls: [url], deleteVideo: false })).status, 200);
  assert.ok(await fs.stat(task.localVideo));
});

test('byte ranges sharing a URL have distinct caches, including ignored Range responses', async t => {
  const { parseM3U8 } = require('../cjs/lib/parseM3u8.js');
  const { tsDownload } = require('../cjs/lib/ts-download.js');
  const dir = await temporary(t);
  const content = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n#EXT-X-BYTERANGE:3@0\nshared.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:3\nshared.ts\n#EXT-X-ENDLIST';
  const origin = await serve(t, (req, res) => res.end(req.url === '/index.txt' ? content : 'abcdef'));
  const info = await parseM3U8(origin + '/index.txt', dir);
  assert.notEqual(info.data[0].tsOut, info.data[1].tsOut);
  for (const item of info.data) await tsDownload(item);
  assert.equal(await fs.readFile(info.data[0].tsOut, 'utf8'), 'abc');
  assert.equal(await fs.readFile(info.data[1].tsOut, 'utf8'), 'def');
});

test('redirected manifests resolve relative fragments against the final location', async t => {
  const { parseM3U8 } = require('../cjs/lib/parseM3u8.js');
  const dir = await temporary(t);
  const origin = await serve(t, (req, res) => {
    if (req.url === '/entry.txt') res.writeHead(302, { location: '/nested/index.txt' }).end();
    else res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST');
  });
  const info = await parseM3U8(origin + '/entry.txt', dir);
  assert.equal(info.data[0].uri, origin + '/nested/segment.ts');
});

test('streaming TS header repair preserves the original cache', async t => {
  const fixture = await media(t); if (!fixture) return;
  const segmentName = fixture.content.split('\n').find(line => line && !line.startsWith('#'));
  const file = path.join(fixture.dir, segmentName);
  const original = await fs.readFile(file);
  const disguised = Buffer.concat([Buffer.from('fake-image-header'), original]);
  await fs.writeFile(file, disguised);
  const output = await m3u8Convert({ saveDir: fixture.dir, filename: 'repaired.mp4' }, [{ tsOut: file, duration: 1 }]);
  assert.ok(probe(output).streams.some(stream => stream.codec_type === 'video'));
  assert.deepEqual(await fs.readFile(file), disguised);
});

test('cancelling a queued merge releases later jobs', async t => {
  const fixture = await media(t); if (!fixture) return;
  const segmentName = fixture.content.split('\n').find(line => line && !line.startsWith('#'));
  const data = [{ tsOut: path.join(fixture.dir, segmentName), duration: 1 }];
  const first = m3u8Convert({ saveDir: fixture.dir, filename: 'first.mp4' }, data);
  const controller = new AbortController();
  const second = m3u8Convert({ saveDir: fixture.dir, filename: 'cancelled.mp4', signal: controller.signal }, data);
  const cancelled = assert.rejects(second, /abort/i);
  controller.abort();
  const third = m3u8Convert({ saveDir: fixture.dir, filename: 'third.mp4' }, data);
  await Promise.all([first, cancelled, third]);
  assert.ok(await fs.stat(path.join(fixture.dir, 'third.mp4')));
  await assert.rejects(fs.stat(path.join(fixture.dir, 'cancelled.mp4')));
});

test('existing configuration and task records migrate without starting old downloads', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);
  const url = 'https://example.test/previous.m3u8';
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    dlOptions: { saveDir: './previous-downloads', threadNum: 3, headers: 'X-Source: previous' },
    webOptions: { maxDownloads: 1, showPreview: true, showLocalPlay: true },
  }));
  await fs.writeFile(path.join(dir, 'cache.json'), JSON.stringify([[url, {
    url, filename: 'previous.mp4', status: 'resume', progress: 100, phase: 'merging',
    options: { filename: 'previous.mp4', headers: 'Referer: https://source.example/' },
  }]]));
  server = new DLServer({ port: 0, cacheDir: dir });
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}/api/`;
  const config = (await (await fetch(base + 'config')).json()).data;
  assert.equal(config.saveDir, './previous-downloads'); assert.equal(config.threadNum, 3);
  assert.equal(config.headers, 'X-Source: previous'); assert.equal(config.showPreview, undefined);
  const tasks = (await (await fetch(base + 'tasks')).json()).data;
  assert.equal(tasks[url].status, 'pause'); assert.equal(tasks[url].filename, 'previous.mp4');
  assert.equal(tasks[url].options.headers, 'Referer: https://source.example/');
});

test('failed-segment API retries only failed media requests', async t => {
  let server;
  t.after(() => server?.close());
  const fixture = await media(t); if (!fixture) return;
  const dir = await temporary(t);
  const legacyUrl = 'https://example.test/legacy-failure.m3u8';
  await fs.writeFile(path.join(dir, 'cache.json'), JSON.stringify([[legacyUrl, { url: legacyUrl, status: 'error', tsFailed: 1, options: {} }]]));
  const names = fixture.content.split('\n').filter(line => line && !line.startsWith('#'));
  const failedName = '/' + names[1];
  let fail = true;
  const requests = new Map();
  const handler = mediaHandler(fixture);
  const origin = await serve(t, (req, res) => {
    requests.set(req.url, (requests.get(req.url) || 0) + 1);
    if (req.url === failedName && fail) res.writeHead(404).end('fixture failure');
    else void handler(req, res);
  });
  server = new DLServer({ port: 0, cacheDir: dir }); await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}/api/`;
  const call = async (endpoint, body) => (await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  await call('config', { saveDir: fixture.dir });
  const url = origin + '/index.txt';
  await call('download', { list: [{ url, filename: 'only-failed' }] });
  async function waitFor(status) {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const task = (await call('tasks')).data[url];
      if (task.status === status) return task;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.fail(`Task did not reach ${status}`);
  }
  const broken = await waitFor('error');
  assert.equal(broken.tsSuccess, names.length - 1); assert.equal(broken.tsFailed, 1);
  assert.equal(broken.hasSegmentDetails, true);
  const snapshot = (await call('segments?url=' + encodeURIComponent(url))).data;
  assert.equal(snapshot.items.filter(item => item.status === 'error').length, 1);
  const before = new Map(requests);
  fail = false;
  assert.equal((await call('retry-failed', { all: true })).code, 0);
  const complete = await waitFor('done');
  assert.equal(complete.tsFailed, 0);
  for (const name of names) assert.equal(requests.get('/' + name), before.get('/' + name) + (('/' + name === failedName) ? 1 : 0));
  assert.ok(Number(probe(complete.localVideo).format.duration) > 2.8);
  assert.equal((await call('tasks')).data[legacyUrl].status, 'error');
});

test('live speed and received bytes update before a large segment finishes', async t => {
  const fixture = await media(t); if (!fixture) return;
  const origin = await serve(t, async (req, res) => {
    const filename = req.url === '/index.txt' ? fixture.list : path.join(fixture.dir, path.basename(req.url));
    const data = await fs.readFile(filename);
    if (req.url === '/index.txt') { res.end(data); return; }
    let offset = 0;
    const timer = setInterval(() => {
      res.write(data.subarray(offset, offset + 512)); offset += 512;
      if (offset >= data.length) { clearInterval(timer); res.end(); }
    }, 35);
    res.once('close', () => clearInterval(timer));
  });
  const snapshots = [];
  const result = await m3u8Download(origin + '/index.txt', { filename: 'live-speed', saveDir: fixture.dir, cacheDir: path.join(fixture.dir, 'cache'), threadNum: 1,
    onProgress: (_a, _b, _c, stats) => snapshots.push(stats),
  });
  assert.equal(result.errmsg, undefined);
  assert.ok(snapshots.some(stats => stats.tsSuccess === 0 && stats.downloadedSize > 0 && stats.speed > 0), 'No streaming progress before first segment completion');
});

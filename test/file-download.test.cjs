const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { downloadResource, fileDownload, m3u8DLStop } = require('../cjs/index.js');
const { formatOptions } = require('../cjs/lib/format-options.js');
const { md5 } = require('../cjs/lib/utils.js');
const { DLServer } = require('../cjs/server/download-server.js');

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-file-test-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  return dir;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function options(dir, extra = {}) { return { saveDir: dir, cacheDir: path.join(dir, 'cache'), ...extra }; }
async function seed(dir, url, prefix, state = {}) {
  const cache = path.join(dir, 'cache', md5(url));
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'download.part'), prefix);
  await fs.writeFile(path.join(cache, 'file.json'), JSON.stringify({ url, etag: '"version-1"', ...state }));
  return cache;
}

test('auto detection uses pathname and preserves file extensions and forced HLS', async () => {
  assert.equal((await formatOptions('https://example.com/a.MP4?token=x')).options.type, 'file');
  assert.equal((await formatOptions('https://example.com/zh.vtt?token=x')).options.filename, 'zh.vtt');
  assert.equal((await formatOptions('https://example.com/zh.vtt', { filename: '中文字幕' })).options.filename, '中文字幕.vtt');
  assert.equal((await formatOptions('https://example.com/index.txt?file=foo.mp4')).options.type, 'm3u8');
  assert.equal((await formatOptions('https://example.com/fake.mp4', { type: 'm3u8' })).options.type, 'm3u8');
  assert.equal((await formatOptions('https://example.com/api?id=1', { type: 'file', filename: 'video.mp4' })).options.filename, 'video.mp4');
  // A dotted non-media suffix must still gain an extension instead of being treated as one.
  assert.equal((await formatOptions('https://example.com/video/1.10', { type: 'file' })).options.filename, '1.10.bin');
  assert.equal((await formatOptions('https://example.com/video/1.10', { type: 'file', filename: 'v1.2' })).options.filename, 'v1.2.bin');
  await assert.rejects(formatOptions('https://example.com/video.mp4', { type: 'bad' }), /下载类型/);
});

test('MP4 and VTT direct files preserve exact bytes, names and request headers', async t => {
  const dir = await temporary(t);
  const video = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(200000, 71)]);
  const subtitle = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\n你好，世界\n');
  const records = [];
  const origin = await serve(t, (req, res) => {
    records.push(req.headers);
    assert.equal(req.headers.referer, 'https://source.example/watch');
    res.setHeader('content-type', req.url.startsWith('/zh') ? 'text/vtt' : 'video/mp4');
    res.end(req.url.startsWith('/zh') ? subtitle : video);
  });
  for (const [name, content] of [['video.mp4', video], ['zh.vtt', subtitle]]) {
    const result = await downloadResource(`${origin}/${name}?token=abc`, options(dir, { headers: { Referer: 'https://source.example/watch' } }));
    assert.equal(result.errmsg, undefined);
    assert.equal(path.basename(result.filepath), name);
    assert.equal(result.stats.downloadType, 'file'); assert.equal(result.stats.progress, 100);
    assert.deepEqual(await fs.readFile(result.filepath), content);
  }
  const existing = await downloadResource(`${origin}/video.mp4?token=abc`, options(dir));
  assert.equal(existing.isExist, true); assert.equal(records.length, 2);
  assert.deepEqual(await fs.readdir(path.join(dir, 'cache')), []);
});

test('direct download reports live bytes, supports shared stop and resumes a validated prefix', async t => {
  const dir = await temporary(t);
  const content = Buffer.alloc(3 * 1024 * 1024, 42);
  const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.headers);
    let position = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
    res.writeHead(position ? 206 : 200, { etag: '"v1"', 'content-length': content.length - position,
      ...(position ? { 'content-range': `bytes ${position}-${content.length - 1}/${content.length}` } : {}) });
    const timer = setInterval(() => {
      res.write(content.subarray(position, position += 65536));
      if (position >= content.length) { clearInterval(timer); res.end(); }
    }, 20);
    res.once('close', () => clearInterval(timer));
  });
  const url = `${origin}/video.mp4`;
  let sawLive = false;
  const paused = await downloadResource(url, options(dir, { onProgress: (_n, _total, _item, stats) => {
    if (stats.downloadedSize > 0) { sawLive = stats.speed > 0 && stats.progress < 100; m3u8DLStop(url); }
  } }));
  assert.equal(paused.paused, true); assert.equal(sawLive, true);
  await assert.rejects(fs.stat(path.join(dir, 'video.mp4')), { code: 'ENOENT' });
  const prefix = (await fs.stat(path.join(dir, 'cache', md5(url), 'download.part'))).size;
  assert.ok(prefix > 0 && prefix < content.length);
  const result = await downloadResource(url, options(dir));
  assert.equal(result.errmsg, undefined); assert.equal(requests.length, 2);
  assert.equal(requests[1].range, `bytes=${prefix}-`); assert.equal(requests[1]['if-range'], '"v1"');
  assert.deepEqual(await fs.readFile(result.filepath), content);
});

for (const mode of ['ignored-range', 'changed-etag', 'invalid-range', 'range-416', 'no-validator']) {
  test(`resume safely handles ${mode}`, async t => {
    const dir = await temporary(t);
    const content = Buffer.alloc(500000, 82);
    const records = [];
    const origin = await serve(t, (req, res) => {
      records.push(req.headers);
      if (req.headers.range && mode === 'invalid-range') {
        res.writeHead(206, { 'content-range': `bytes 0-${content.length - 1}/${content.length}`, etag: '"version-1"' });
        res.end(content); return;
      }
      if (req.headers.range && mode === 'range-416') { res.writeHead(416).end(); return; }
      res.setHeader('etag', mode === 'changed-etag' ? '"version-2"' : '"version-1"');
      res.end(content);
    });
    const url = `${origin}/test.mp4`;
    await seed(dir, url, Buffer.alloc(300000, 65), { total: content.length, ...(mode === 'no-validator' ? { etag: undefined } : {}) });
    const result = await downloadResource(url, options(dir));
    assert.equal(result.errmsg, undefined);
    assert.deepEqual(await fs.readFile(result.filepath), content);
    assert.equal(records[0].range, mode === 'no-validator' ? undefined : 'bytes=300000-');
    if (['invalid-range', 'range-416'].includes(mode)) assert.equal(records[1].range, undefined);
  });
}

test('unknown content length, forced extensionless file and custom Range cannot truncate it', async t => {
  const dir = await temporary(t);
  const origin = await serve(t, (req, res) => {
    assert.equal(req.headers.range, undefined);
    res.writeHead(200, { 'content-type': 'text/vtt' });
    res.write('WEBVTT\n'); res.end('\n00:00.000 --> 00:01.000\n测试\n');
  });
  const result = await fileDownload(`${origin}/api?id=1`, options(dir, { filename: 'subtitles.vtt', headers: { Range: 'bytes=10-20' } }));
  assert.equal(result.errmsg, undefined);
  assert.match(await fs.readFile(result.filepath, 'utf8'), /^WEBVTT/);
  assert.equal(result.stats.progress, 100);
});

test('truncated responses and HTTP errors never publish a completed file', async t => {
  const dir = await temporary(t);
  let missingRequests = 0;
  const origin = await serve(t, (req, res) => {
    if (req.url === '/missing.vtt') { missingRequests++; res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': 100000, etag: '"broken"' });
    res.flushHeaders(); res.write(Buffer.alloc(1000)); setImmediate(() => res.destroy());
  });
  const truncated = await downloadResource(`${origin}/broken.mp4`, options(dir));
  assert.ok(truncated.errmsg); assert.equal(truncated.filepath, undefined);
  await assert.rejects(fs.stat(path.join(dir, 'broken.mp4')), { code: 'ENOENT' });
  const missing = await downloadResource(`${origin}/missing.vtt`, options(dir));
  assert.match(missing.errmsg, /HTTP 404/); assert.equal(missingRequests, 1);
  await assert.rejects(fs.stat(path.join(dir, 'missing.vtt')), { code: 'ENOENT' });
});

test('direct file redirects retain manual Referer but strip cross-origin credentials', async t => {
  const dir = await temporary(t);
  const target = await serve(t, (req, res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.referer, 'https://source.example/');
    res.end('WEBVTT\n');
  });
  const origin = await serve(t, (_req, res) => res.writeHead(302, { location: target + '/target.vtt' }).end());
  const result = await downloadResource(origin + '/source.vtt', options(dir, { headers: { Cookie: 'secret', Authorization: 'secret', Referer: 'https://source.example/' } }));
  assert.equal(result.errmsg, undefined); assert.equal(await fs.readFile(result.filepath, 'utf8'), 'WEBVTT\n');
});

test('server queues direct files, keeps original extensions and serves finished subtitles', async t => {
  let server;
  t.after(() => server?.close());
  const dir = await temporary(t);
  const origin = await serve(t, (_req, res) => res.end('WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n'));
  server = new DLServer({ port: 0, cacheDir: path.join(dir, 'server-cache') });
  await server.ready;
  const base = `http://127.0.0.1:${server.server.address().port}/api/`;
  const call = async (endpoint, body) => (await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  await call('config', { saveDir: dir });
  const urls = [origin + '/first.vtt', origin + '/second.vtt'];
  assert.equal((await call('download', { list: urls.map(url => ({ url })) })).code, 0);
  let tasks;
  for (let i = 0; i < 100; i++) {
    tasks = (await call('tasks')).data;
    if (urls.every(url => ['done', 'error'].includes(tasks[url]?.status))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  for (const url of urls) { assert.equal(tasks[url].status, 'done', tasks[url].errmsg); assert.equal(tasks[url].downloadType, 'file'); assert.match(tasks[url].filename, /\.vtt$/); }
  const saved = await fetch(base + 'file?url=' + encodeURIComponent(urls[0]));
  assert.match(saved.headers.get('content-disposition'), /first\.vtt/);
  assert.match(await saved.text(), /^WEBVTT/);
  assert.equal((await call('delete', { urls: [urls[0]], deleteCache: true, deleteVideo: false })).code, 0);
  assert.ok((await call('tasks')).data[urls[1]]);
  assert.ok(await fs.stat(tasks[urls[0]].localVideo));
});

test('a same-named file from another link is never reported as already downloaded', async t => {
  const dir = await temporary(t);
  const video = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(200000, 71)]);
  const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'video/mp4');
    res.end(video);
  });
  await fs.writeFile(path.join(dir, 'video.mp4'), Buffer.alloc(1234, 65));
  const result = await downloadResource(`${origin}/a/video.mp4`, options(dir, { filename: 'video.mp4' }));
  assert.equal(result.errmsg, undefined);
  assert.equal(result.isExist, undefined);
  assert.equal(requests.length, 1);
  assert.deepEqual(await fs.readFile(result.filepath), video);
  const again = await downloadResource(`${origin}/a/video.mp4`, options(dir, { filename: 'video.mp4' }));
  assert.equal(again.isExist, true); assert.equal(requests.length, 1);
  await fs.writeFile(path.join(dir, 'video.mp4'), Buffer.alloc(1234, 65));
  const other = await downloadResource(`${origin}/b/video.mp4`, options(dir, { filename: 'video.mp4' }));
  assert.equal(other.isExist, undefined); assert.equal(requests.length, 2);
  assert.deepEqual(await fs.readFile(other.filepath), video);
});

test('a failed replacement keeps the previous same-named file intact', async t => {
  const dir = await temporary(t);
  const origin = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 500000 });
    res.write(Buffer.alloc(1000, 90));
    setTimeout(() => res.destroy(), 10);
  });
  const previous = Buffer.alloc(1234, 65);
  await fs.writeFile(path.join(dir, 'video.mp4'), previous);
  const result = await downloadResource(`${origin}/video.mp4`, options(dir));
  assert.ok(result.errmsg);
  assert.deepEqual(await fs.readFile(path.join(dir, 'video.mp4')), previous);
});

test('an extensionless link that serves a playlist is downloaded as HLS, not saved as video', async t => {
  const dir = await temporary(t);
  const segment = Buffer.alloc(188 * 4, 71);
  const origin = await serve(t, (req, res) => {
    if (req.url.startsWith('/play')) { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n'); return; }
    res.setHeader('content-type', 'video/mp2t'); res.end(segment);
  });
  const result = await downloadResource(`${origin}/play?id=1`, options(dir, { filename: 'show.mp4', convert: false }));
  assert.equal(result.stats.downloadType, 'm3u8');
  assert.notEqual(result.isExist, true);
  // The playlist itself must never be published as the video file.
  const published = await fs.readFile(path.join(dir, 'show.mp4'), 'utf8').catch(() => '');
  assert.ok(!published.startsWith('#EXTM3U'));
});

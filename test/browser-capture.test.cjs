const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { DLServer } = require('../cjs/server/download-server.js');

test('remote browser capture merges standard HLS responses and leaves incomplete sessions unpublished', {
  skip: !process.env.TEST_BROWSER_PATH && 'Set TEST_BROWSER_PATH to run with a local Chromium executable',
  timeout: 35_000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-hls-test-'));
  let browser;
  let downloader;
  let source;
  t.after(async () => {
    await downloader?.close();
    await browser?.close();
    source?.closeAllConnections();
    await new Promise(done => source ? source.close(done) : done());
    await fs.rm(dir, { recursive: true, force: true });
  });
  browser = await chromium.launchServer({
    executablePath: process.env.TEST_BROWSER_PATH, host: '127.0.0.1', args: ['--remote-debugging-port=0'],
  });
  const profile = browser.process().spawnargs.find(arg => arg.startsWith('--user-data-dir=')).split('=')[1];
  const debugPort = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25', '-t', '3', '-c:v', 'libx264',
    '-g', '25', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', 'index.m3u8'], { cwd: dir, windowsHide: true });
  const manifest = await fs.readFile(path.join(dir, 'index.m3u8'), 'utf8');
  const hlsScript = await fs.readFile(require.resolve('hls.js'));
  const segments = manifest.split('\n').filter(line => line.endsWith('.ts'));
  const requests = [];
  source = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const mode = url.searchParams.get('case');
    if (url.pathname === '/hls.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(hlsScript);
      return;
    }
    if (url.pathname === '/viewer') { res.end('Browser viewer fixture'); return; }
    if (url.pathname === '/watch') {
      res.setHeader('content-type', 'text/html');
      if (mode === 'stalled') {
        res.end("<script>fetch('/index.m3u8?case=stalled')</script>");
        return;
      }
      if (mode === 'play') {
        res.end(`<video muted controls></video><button>Play</button><script src="/hls.js"></script><script>
          document.querySelector('button').onclick = () => {
            const video = document.querySelector('video');
            const hls = new Hls({enableWorker:false});
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
            hls.loadSource('/index.m3u8?case=play');
            hls.attachMedia(video);
          };
          document.querySelector('button').click();
        </script>`);
        return;
      }
      res.end(`<script>(async()=>{
        const manifest = await fetch('/index.m3u8?case=incomplete').then(res=>res.text());
        const parts = manifest.split('\\n').filter(line=>line.endsWith('.ts'));
        await fetch('/'+parts[0]).then(res=>res.arrayBuffer());
      })()</script>`);
      return;
    }
    if (url.pathname === '/index.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      if (mode === 'stalled') { res.write('#EXTM3U\n'); return; }
      res.end(manifest);
      return;
    }
    if (segments.includes(url.pathname.slice(1))) {
      requests.push({ segment: url.pathname.slice(1), browser: /Edg|Chrome/.test(req.headers['user-agent'] || '') });
      res.setHeader('content-type', 'video/mp2t');
      res.end(await fs.readFile(path.join(dir, url.pathname.slice(1))));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(done => source.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${source.address().port}`;
  const settings = { DS_BROWSER_ENDPOINT: browser.wsEndpoint(), DS_BROWSER_WINDOW: origin + '/viewer', DS_BROWSER_ORIGINS: origin };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  downloader = new DLServer({ port: 0, token: 'test-browser-capture', cacheDir: path.join(dir, 'cache') });
  await downloader.ready;
  const appUrl = `http://127.0.0.1:${downloader.server.address().port}`;
  const api = appUrl + '/api/';
  const call = async (name, body, auth = 'test-browser-capture') => (await fetch(api + name, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: auth }, body: body && JSON.stringify(body),
  })).json();
  async function until(url, predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = (await call('tasks')).data[url];
      if (task && predicate(task)) return task;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.fail(`Task did not reach the expected state: ${JSON.stringify((await call('tasks')).data[url])}`);
  }

  const url = origin + '/watch?case=play';
  assert.notEqual((await call('browser-capture', { url }, 'wrong')).code, 0);
  assert.notEqual((await call('browser-capture', { url: 'https://unconfigured.example/' })).code, 0);
  await call('config', { saveDir: dir });
  assert.equal((await call('browser-capture', { url, filename: 'browser-copy' })).code, 0);
  const done = await until(url, task => ['done', 'error'].includes(task.status));
  assert.equal(done.status, 'done', done.errmsg);
  assert.equal(done.tsSuccess, segments.length);
  assert.deepEqual(requests.map(item => item.segment), segments);
  assert.ok(requests.every(item => item.browser));
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', done.localVideo], { encoding: 'utf8' }));
  assert.ok(duration >= 2.9 && duration < 3.2);

  const incomplete = origin + '/watch?case=incomplete';
  assert.equal((await call('browser-capture', { url: incomplete, filename: 'incomplete' })).code, 0);
  const partial = await until(incomplete, task => task.tsSuccess === 1);
  assert.equal((await call('pause', { urls: [incomplete] })).code, 0);
  assert.equal((await until(incomplete, task => task.status === 'pause')).localVideo, undefined);
  const [attempt] = await fs.readdir(partial.cacheDir);
  assert.ok((await fs.stat(path.join(partial.cacheDir, attempt, '0.ts'))).size > 0);
  await assert.rejects(fs.stat(path.join(dir, 'incomplete.mp4')), { code: 'ENOENT' });

  const stalled = origin + '/watch?case=stalled';
  assert.equal((await call('browser-capture', { url: stalled, filename: 'stalled' })).code, 0);
  await until(stalled, task => task.status === 'resume');
  await new Promise(done => setTimeout(done, 500));
  assert.equal((await call('pause', { urls: [stalled] })).code, 0);
  await until(stalled, task => task.status === 'pause');

  const client = await chromium.connect(browser.wsEndpoint());
  try {
    for (const width of [1280, 375]) {
      const page = await client.newPage({ viewport: { width, height: 820 } });
      await page.addInitScript(() => sessionStorage.setItem('m3u8-token', 'test-browser-capture'));
      await page.goto(appUrl);
      await page.getByText('服务已连接').waitFor({ timeout: 5000 });
      const entry = page.getByRole('button', { name: '打开浏览器' });
      const box = await entry.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      const opened = page.waitForEvent('popup', { timeout: 5000 });
      await entry.click();
      const popup = await opened;
      await popup.waitForURL(origin + '/viewer');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await popup.close();
      await page.close();
    }
    const captures = Object.values((await call('tasks')).data).filter(task => task.url.startsWith('browser:'));
    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.equal(capture.browserSource, undefined);

    const devtools = `http://127.0.0.1:${debugPort}/json/list`;
    let target;
    for (let attempt = 0; attempt < 50 && !target; attempt++) {
      const tabs = await (await fetch(devtools)).json();
      target = tabs.find(tab => tab.type === 'page' && tab.url === 'about:blank');
      if (!target) await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(target, 'Browser capture opens a blank Chromium tab');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } })));
        socket.once('message', value => {
          const reply = JSON.parse(value);
          if (reply.error || reply.result?.errorText) reject(new Error(JSON.stringify(reply)));
          else resolve();
        });
      });
      const saved = await until(capture.url, task => ['done', 'error'].includes(task.status));
      assert.equal(saved.status, 'done', saved.errmsg);
      assert.equal(saved.browserSource, origin + '/watch');
      assert.equal(saved.tsSuccess, segments.length);
    } finally { socket.close(); }
  } finally {
    await client.close();
  }
});

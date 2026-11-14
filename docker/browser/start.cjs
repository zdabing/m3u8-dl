const { chromium } = require('playwright-core');

async function start() {
  const key = process.env.DS_BROWSER_KEY;
  if (!key || !/^[a-zA-Z0-9_-]{32,}$/.test(key)) throw new Error('DS_BROWSER_KEY must be at least 32 URL-safe characters');
  const server = await chromium.launchServer({
    executablePath: '/usr/bin/chromium',
    host: '127.0.0.1',
    port: 9323,
    wsPath: '/' + key,
    headless: false,
    args: ['--window-size=1280,780', '--disable-background-networking'],
  });
  process.once('SIGTERM', () => { void server.close(); });
  process.once('SIGINT', () => { void server.close(); });
}

start().catch(error => { console.error(error.message); process.exitCode = 1; });

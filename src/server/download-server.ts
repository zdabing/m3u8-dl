import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { downloadResource } from '../lib/download.js';
import { formatOptions } from '../lib/format-options.js';
import { extractMedia } from '../lib/getM3u8Urls.js';
import { initProxy } from '../lib/init-proxy.js';
import { checkFileExists, formatHeaders, logger, md5, normalizeDownloadUrl } from '../lib/utils.js';
import type { RssBridgeFeed, SegmentSnapshot, ServerConfig, TaskItem } from '../types/contract.js';
import type { M3u8DLOptions } from '../types/m3u8.js';
import { VideoParser } from '../video-parser/index.js';
import { sourceUrl } from '../video-parser/platform.js';
import { catCatchTasks } from './cat-catch.js';
import { defaultRssBridgeFeeds, RssBridgeService } from './rss-bridge.js';

function validateHttpHref(raw: unknown, label: string, required = true) {
  if (typeof raw !== 'string') throw new Error(`${label}无效`);
  const text = raw.trim();
  if (!text) {
    if (required) throw new Error(`${label}不能为空`);
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label}应为有效的 http 或 https 地址`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label}应为 http 或 https 地址`);
  return parsed.href;
}

function validateRssFeeds(input: unknown): RssBridgeFeed[] {
  if (!Array.isArray(input) || input.length > 30) throw new Error('订阅源列表最多支持 30 个');
  const seen = new Set<string>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`第 ${index + 1} 个订阅源格式无效`);
    const item = entry as Partial<RssBridgeFeed>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('订阅源 ID 仅支持 1–40 位字母、数字、下划线或短横线');
    const lower = id.toLowerCase();
    if (seen.has(lower)) throw new Error(`订阅源 ID 重复: ${id}`);
    seen.add(lower);
    const name = (typeof item.name === 'string' ? item.name.trim() : '').slice(0, 60) || id;
    if (typeof item.enabled !== 'boolean') throw new Error(`订阅源 ${id} 启用状态无效`);
    if (item.mode !== 'rss' && item.mode !== 'html') throw new Error(`订阅源 ${id} 模式应为 rss 或 html`);
    const url = validateHttpHref(item.url, `订阅源 ${id} 地址`, true);
    const itemPattern = typeof item.itemPattern === 'string' ? item.itemPattern.trim() : '';
    if (itemPattern.length > 200) throw new Error(`订阅源 ${id} 链接筛选词最多 200 个字符`);
    const referer = item.referer === undefined ? '' : validateHttpHref(item.referer, `订阅源 ${id} Referer`, false);
    if (!Number.isInteger(item.limit) || item.limit < 1 || item.limit > 50) throw new Error(`订阅源 ${id} 保留条数应为 1–50`);
    if (!Number.isInteger(item.cacheTtl) || item.cacheTtl < 0 || item.cacheTtl > 86400)
      throw new Error(`订阅源 ${id} 缓存时长应为 0–86400 秒`);
    return { id, name, enabled: item.enabled, mode: item.mode, url, itemPattern, referer, limit: item.limit, cacheTtl: item.cacheTtl };
  });
}

interface DLServerOptions {
  port?: number;
  cacheDir?: string;
  configPath?: string;
  debug?: boolean;
  token?: string;
}
interface Run {
  controller: AbortController;
  completion: Promise<void>;
}
const rootDir = resolve(__dirname, '../..');
export class DLServer {
  app: Express = express();
  server: Server;
  wss: WebSocketServer;
  ready: Promise<void>;
  private token: string;
  private cacheDir: string;
  private configPath: string;
  private tasks = new Map<string, TaskItem>();
  private runs = new Map<string, Run>();
  private saveTimer: NodeJS.Timeout;
  private broadcastTimer: NodeJS.Timeout;
  private writeQueue = Promise.resolve();
  private version = '1.10.0';
  private closing = false;
  private extractions = new Set<AbortController>();
  private rssBridge: RssBridgeService;
  private cfg: ServerConfig = {
    saveDir: process.env.DS_SAVE_DIR || './downloads',
    threadNum: 4,
    maxDownloads: 2,
    delCache: true,
    ffmpegPath: process.env.DS_FFMPEG_PATH || '',
    headers: '',
    mergeTimeout: 180,
    proxyMode: (process.env.DS_PROXY_MODE || 'system') as ServerConfig['proxyMode'],
    proxyUrl: process.env.DS_PROXY_URL || '',
    noProxy: process.env.DS_NO_PROXY || '',
    rssBridgeEnabled: ['1', 'true', 'yes'].includes(String(process.env.DS_RSS_BRIDGE_ENABLED || '').toLowerCase()),
    rssBridgeFeedUrl: process.env.DS_RSS_BRIDGE_FEED_URL || 'https://tangxinvlog.app/rss.xml',
    rssBridgeLimit: Math.min(50, Math.max(1, Number.parseInt(process.env.DS_RSS_BRIDGE_LIMIT || '20', 10) || 20)),
    rssBridgeReferer: process.env.DS_RSS_BRIDGE_REFERER || '',
    rssBridgeCacheTtl: Math.min(86400, Math.max(0, Number.parseInt(process.env.DS_RSS_BRIDGE_CACHE_TTL || '300', 10) || 300)),
  };
  constructor(options: DLServerOptions = {}) {
    this.cacheDir = resolve(options.cacheDir || process.env.DS_CACHE_DIR || resolve(homedir(), '.m3u8-dl/cache'));
    this.configPath = options.configPath || resolve(this.cacheDir, 'config.json');
    this.token = options.token || process.env.DS_SECRET || process.env.DS_TOKEN || '';
    this.cfg.rssBridgeFeeds = defaultRssBridgeFeeds(this.cfg);
    this.rssBridge = new RssBridgeService(this.cacheDir, () => this.cfg);
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.ready = this.init(options.port ?? (Number(process.env.DS_PORT) || 6600));
    this.ready.catch(error => logger.error('服务器启动失败:', error));
  }
  private authorized(token: string) {
    return !this.token || token === this.token || token === md5(this.token.trim()).slice(0, 8);
  }
  private async init(port: number) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    try {
      const stored = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      const config = { ...(stored.dlOptions || stored), ...stored.webOptions };
      for (const key of Object.keys(this.cfg) as (keyof ServerConfig)[]) {
        if (key in config) Object.assign(this.cfg, { [key]: config[key] });
      }
      if (typeof this.cfg.headers !== 'string') this.cfg.headers = JSON.stringify(this.cfg.headers);
      this.cfg.maxDownloads = Math.min(5, Math.max(1, Number(this.cfg.maxDownloads) || 2));
      this.cfg.rssBridgeEnabled = Boolean(this.cfg.rssBridgeEnabled);
      this.cfg.rssBridgeLimit = Math.min(50, Math.max(1, Number(this.cfg.rssBridgeLimit) || 20));
      const rssTtl = Number(this.cfg.rssBridgeCacheTtl);
      this.cfg.rssBridgeCacheTtl = Number.isInteger(rssTtl) ? Math.min(86400, Math.max(0, rssTtl)) : 300;
      this.cfg.rssBridgeFeeds = defaultRssBridgeFeeds({
        ...this.cfg,
        rssBridgeFeeds: Array.isArray(config.rssBridgeFeeds) ? config.rssBridgeFeeds : undefined,
      });
    } catch {
      /* First launch. */
    }
    try {
      const entries = JSON.parse(await fs.readFile(resolve(this.cacheDir, 'cache.json'), 'utf8')) as [string, TaskItem][];
      for (const [url, item] of entries) {
        if (['resume', 'pending'].includes(item.status)) item.status = 'pause';
        if (item.options) delete (item.options as M3u8DLOptions).retryFailedOnly;
        this.tasks.set(url, item);
      }
    } catch {
      /* No existing tasks. */
    }
    await this.rssBridge.init();
    await initProxy(this.cfg);
    this.app.use(express.json({ limit: '1mb' }));
    this.app.get('/healthcheck', (_req, res) => res.json({ code: 0, message: 'ok' }));
    this.app.get('/scriptcat.user.js', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.type('application/javascript').sendFile(resolve(rootDir, 'examples/scriptcat-downloader.user.js'));
    });
    this.app.use('/rss-bridge', async (req, res, next) => {
      if (!this.cfg.rssBridgeEnabled) {
        res.status(404).json({ code: 1, message: 'RSS 中转服务未启用，请在设置中开启' });
        return;
      }
      const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
      const authToken = String(req.headers.authorization || queryToken);
      if (!this.authorized(authToken)) {
        res.status(401).json({ code: 1008, message: '请输入正确的访问密码' });
        return;
      }
      try {
        await this.rssBridge.handle(req, res, this.token ? queryToken : '');
      } catch (error) {
        next(error);
      }
    });
    this.app.use('/api', (req, res, next) => {
      const token = String(req.headers.authorization || (req.path === '/file' ? req.query.token || '' : ''));
      if (!this.authorized(token)) {
        res.status(401).json({ code: 1008, message: '请输入正确的访问密码' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    this.routes();
    // Only the new app assets are public. Player and old CDN resources are not served.
    this.app.use('/assets', express.static(resolve(rootDir, 'client/assets')));
    this.app.get(['/', '/index.html', /^\/page(?:\/.*)?$/], (_req, res) => res.sendFile(resolve(rootDir, 'client/index.html')));
    this.app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
      res.status(400).json({ code: 1, message: error.message });
    });
    this.wss.on('connection', (ws, req) => {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
      if (!this.authorized(token)) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      ws.send(JSON.stringify({ type: 'serverInfo', data: { version: this.version } }));
      ws.send(JSON.stringify({ type: 'tasks', data: Object.fromEntries(this.tasks) }));
    });
    await new Promise<void>((resolveReady, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        resolveReady();
      });
    });
    logger.info(`M3U8 下载器: http://localhost:${(this.server.address() as { port: number }).port}`);
  }
  private broadcast(immediate = false) {
    if (this.broadcastTimer && !immediate) return;
    clearTimeout(this.broadcastTimer);
    const send = () => {
      this.broadcastTimer = undefined;
      const message = JSON.stringify({ type: 'tasks', data: Object.fromEntries(this.tasks) });
      for (const client of this.wss.clients) if (client.readyState === 1) client.send(message);
    };
    if (immediate) send();
    else this.broadcastTimer = setTimeout(send, 250);
  }
  private persist() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush().catch(error => logger.error('任务保存失败:', error));
    }, 500);
  }
  private flush() {
    const content = JSON.stringify([...this.tasks]);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const target = resolve(this.cacheDir, 'cache.json');
        await fs.writeFile(`${target}.part`, content);
        await fs.rename(`${target}.part`, target);
      });
    return this.writeQueue;
  }
  private async reserveFilename(item: TaskItem, original: string, saveDir: string, signal?: AbortSignal) {
    const ext = extname(original);
    const stem = basename(original, ext);
    for (let index = 1; ; index++) {
      const filename = index === 1 ? original : `${stem} (${index})${ext}`;
      const alternate = `${basename(filename, ext)}.ts`;
      const exists =
        (await checkFileExists(resolve(saveDir, filename))) ||
        (item.browserCapture && (await checkFileExists(resolve(saveDir, alternate))));
      signal?.throwIfAborted();
      if (exists || [...this.tasks.values()].some(task => task !== item && task.filename === filename)) continue;
      item.filename = filename;
      item.options.filename = filename;
      this.tasks.set(item.url, item);
      return filename;
    }
  }
  private async enqueue(input: string, options: M3u8DLOptions & { useDefaultHeaders?: boolean } = {}, browserCapture = false) {
    if (browserCapture || input.startsWith('browser:')) throw new Error('浏览器保存已移除，请提交网页或媒体链接重新下载');
    const url = sourceUrl(input);
    const existing = this.tasks.get(url);
    if (this.runs.has(url) || existing?.status === 'done') return false;
    if (existing && !!existing.browserCapture !== browserCapture) return false;
    const merged = { ...existing?.options, ...options } as M3u8DLOptions;
    const formatted = await formatOptions(url, { ...this.cfg, ...merged });
    const item: TaskItem = {
      ...existing,
      url,
      browserCapture: browserCapture || undefined,
      status: 'pending',
      phase: 'queued',
      errmsg: '',
      mergeMessage: '',
      mergeProgress: 0,
      filename: formatted.options.filename,
      downloadType: ['file', 'parser'].includes(formatted.options.type) ? 'file' : 'm3u8',
      options: { ...merged, filename: formatted.options.filename },
      cacheDir: resolve(this.cacheDir, md5(url)),
    };
    if (existing) this.tasks.set(url, item);
    else await this.reserveFilename(item, item.filename, formatted.options.saveDir);
    this.persist();
    this.broadcast(true);
    this.startNext();
    return true;
  }
  private startNext() {
    if (this.closing) return;
    for (const item of this.tasks.values()) {
      if (this.runs.size >= this.cfg.maxDownloads) break;
      if (item.status !== 'pending' || this.runs.has(item.url)) continue;
      item.status = 'resume';
      const controller = new AbortController();
      // Reserve the slot before run() can emit its first progress update.
      const run: Run = { controller, completion: Promise.resolve() };
      this.runs.set(item.url, run);
      run.completion = this.run(item, controller).finally(() => {
        this.runs.delete(item.url);
        this.persist();
        this.broadcast(true);
        this.startNext();
      });
    }
  }
  private async run(item: TaskItem, controller: AbortController) {
    try {
      const options = item.options as M3u8DLOptions;
      const report = (stats: Partial<TaskItem>) => {
        if (this.tasks.get(item.url) !== item || controller.signal.aborted) return false;
        Object.assign(item, stats);
        this.broadcast();
        this.persist();
        return true;
      };
      const runOptions: M3u8DLOptions = {
        ...this.cfg,
        ...options,
        cacheDir: this.cacheDir,
        convert: true,
        signal: controller.signal,
        onProgress: (_finished, _total, _current, stats) => report(stats),
      };
      if (item.browserCapture) throw new Error('浏览器保存已移除，请提交网页或媒体链接重新下载');
      const result = await downloadResource(item.url, {
        ...runOptions,
        headers: {
          ...(item.options?.useDefaultHeaders === false ? {} : formatHeaders(this.cfg.headers)),
          ...formatHeaders(options?.headers),
        },
      });
      if (!this.tasks.has(item.url)) return;
      if (result.paused || controller.signal.aborted) item.status = 'pause';
      else if (result.errmsg) {
        item.status = 'error';
        item.errmsg = result.errmsg;
      } else if (result.filepath) {
        item.status = 'done';
        item.phase = 'done';
        item.progress = 100;
        item.localVideo = result.filepath;
        item.filename = basename(result.filepath);
        item.downloadedSize = (await fs.stat(result.filepath)).size;
        item.errmsg = '';
      } else {
        item.status = 'error';
        item.errmsg = '未生成完整文件，缓存已保留';
      }
      item.endTime = Date.now();
    } catch (error) {
      if (this.tasks.has(item.url)) {
        item.status = controller.signal.aborted ? 'pause' : 'error';
        item.errmsg = controller.signal.aborted ? '' : (error as Error).message;
      }
    } finally {
      if (item.options) delete (item.options as M3u8DLOptions).retryFailedOnly;
    }
  }
  private routes() {
    const app = this.app;
    app.get('/api/platforms', (_req, res) => res.json({ code: 0, data: VideoParser.getSupportedPlatforms() }));
    app.post(['/api/extract', '/api/getM3u8Urls', '/api/parse'], async (req, res) => {
      if (this.closing) throw new Error('服务正在关闭');
      const controller = new AbortController();
      this.extractions.add(controller);
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once('close', abort);
      try {
        const headers = { ...formatHeaders(this.cfg.headers), ...formatHeaders(req.body.headers) };
        if (req.path === '/api/parse') {
          const result = await VideoParser.parse(String(req.body.url || ''), headers, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          });
          res.json(result);
          return;
        }
        if (req.body.deep !== undefined && (!Number.isInteger(req.body.deep) || req.body.deep < 0 || req.body.deep > 3))
          throw new Error('搜索深度应为 0–3');
        const pathFilter = req.body.pathFilter || req.body.subUrlRegex || '';
        if (typeof pathFilter !== 'string' || pathFilter.length > 200) throw new Error('子页面路径筛选最多 200 个字符');
        const result = await extractMedia({
          url: req.body.url,
          urls: req.body.urls,
          headers,
          deep: req.body.deep ?? 1,
          maxPages: 30,
          maxUrls: 100,
          pathFilter,
          signal: controller.signal,
        });
        res.json({ code: 0, data: req.path === '/api/getM3u8Urls' ? result.items.map(item => [item.url, item.title]) : result });
      } catch (error) {
        if (!res.destroyed) throw error;
      } finally {
        res.removeListener('close', abort);
        this.extractions.delete(controller);
      }
    });
    app.get('/api/config', (_req, res) => res.json({ code: 0, data: this.cfg }));
    app.post('/api/config', async (req, res) => {
      const next = { ...this.cfg };
      for (const key of Object.keys(next) as (keyof ServerConfig)[]) if (key in req.body) Object.assign(next, { [key]: req.body[key] });
      if (
        ![next.threadNum, next.maxDownloads, next.mergeTimeout].every(Number.isInteger) ||
        next.threadNum < 1 ||
        next.threadNum > 16 ||
        next.maxDownloads < 1 ||
        next.maxDownloads > 5 ||
        next.mergeTimeout < 15 ||
        next.mergeTimeout > 3600
      )
        throw new Error('并发分片为 1–16，任务为 1–5，合并超时为 15–3600 秒');
      if (typeof next.saveDir !== 'string' || !next.saveDir.trim()) throw new Error('保存目录不能为空');
      if (!['custom', 'system', 'disabled'].includes(next.proxyMode)) throw new Error('无效的代理模式');
      formatHeaders(next.headers);
      if (next.proxyMode === 'custom' && !/^https?:\/\//.test(next.proxyUrl)) throw new Error('代理地址应以 http:// 或 https:// 开头');
      if (typeof next.rssBridgeEnabled !== 'boolean') throw new Error('RSS 中转开关参数无效');
      if ('rssBridgeFeeds' in req.body && req.body.rssBridgeFeeds !== undefined) {
        const feeds = validateRssFeeds(req.body.rssBridgeFeeds);
        next.rssBridgeFeeds = feeds;
        const primary = feeds.find(feed => feed.id.toLowerCase() === 'default') || feeds[0];
        if (primary) {
          next.rssBridgeFeedUrl = primary.url;
          next.rssBridgeLimit = primary.limit;
          next.rssBridgeReferer = primary.referer || '';
          next.rssBridgeCacheTtl = primary.cacheTtl;
        }
      } else {
        if (!Number.isInteger(next.rssBridgeLimit) || next.rssBridgeLimit < 1 || next.rssBridgeLimit > 50)
          throw new Error('RSS 条目上限应为 1–50');
        if (!Number.isInteger(next.rssBridgeCacheTtl) || next.rssBridgeCacheTtl < 0 || next.rssBridgeCacheTtl > 86400)
          throw new Error('RSS 缓存时长应为 0–86400 秒');
        next.rssBridgeFeedUrl = validateHttpHref(next.rssBridgeFeedUrl, '上游 RSS 地址', Boolean(next.rssBridgeEnabled));
        next.rssBridgeReferer = validateHttpHref(next.rssBridgeReferer, 'RSS Referer', false);
        const existingFeeds = defaultRssBridgeFeeds(next);
        const targetIndex = existingFeeds.findIndex(feed => feed.id.toLowerCase() === 'default');
        if (targetIndex >= 0) {
          existingFeeds[targetIndex] = {
            ...existingFeeds[targetIndex],
            enabled: true,
            url: next.rssBridgeFeedUrl || existingFeeds[targetIndex].url,
            limit: next.rssBridgeLimit,
            referer: next.rssBridgeReferer,
            cacheTtl: next.rssBridgeCacheTtl,
          };
        } else if (existingFeeds.length) {
          existingFeeds[0] = {
            ...existingFeeds[0],
            url: next.rssBridgeFeedUrl || existingFeeds[0].url,
            limit: next.rssBridgeLimit,
            referer: next.rssBridgeReferer,
            cacheTtl: next.rssBridgeCacheTtl,
          };
        } else if (next.rssBridgeFeedUrl) {
          existingFeeds.push({
            id: 'default',
            name: '默认订阅源',
            enabled: true,
            mode: 'rss',
            url: next.rssBridgeFeedUrl,
            itemPattern: '',
            referer: next.rssBridgeReferer,
            limit: next.rssBridgeLimit,
            cacheTtl: next.rssBridgeCacheTtl,
          });
        }
        next.rssBridgeFeeds = existingFeeds;
      }
      await initProxy(next);
      await fs.mkdir(dirname(this.configPath), { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(next, null, 2));
      this.cfg = next;
      this.rssBridge.invalidateCache();
      this.startNext();
      res.json({ code: 0, message: '设置已保存' });
    });
    app.get('/api/tasks', (_req, res) => res.json({ code: 0, data: Object.fromEntries(this.tasks) }));
    app.get('/api/segments', async (req, res) => {
      const url = String(req.query.url || '');
      const item = this.tasks.get(url);
      if (!item) {
        res.status(404).json({ code: 1, message: '任务不存在' });
        return;
      }
      let snapshot: SegmentSnapshot;
      try {
        snapshot = JSON.parse(await fs.readFile(resolve(this.cacheDir, md5(url), 'segments.json'), 'utf8'));
      } catch {
        snapshot = {
          fingerprint: '',
          items:
            item.status === 'done'
              ? Array.from({ length: item.tsCount || 0 }, (_, index) => ({ index, status: 'done', size: 0, attempts: 0 }))
              : [],
        };
      }
      res.json({ code: 0, data: snapshot });
    });
    app.post('/api/retry-failed', async (req, res) => {
      const urls: string[] = req.body.all ? [...this.tasks.keys()] : req.body.urls || [];
      let count = 0;
      for (const url of urls) {
        const item = this.tasks.get(url);
        if (item?.status !== 'error' || item.browserCapture || this.runs.has(url)) continue;
        const content = await fs.readFile(resolve(this.cacheDir, md5(url), 'segments.json'), 'utf8').catch(() => '');
        if (!content) {
          if (req.body.all) continue;
          throw new Error('暂无失败分片记录，请使用继续下载');
        }
        const snapshot: SegmentSnapshot = JSON.parse(content);
        if (!snapshot.items.some(segment => segment.status === 'error')) continue;
        await this.enqueue(url, { ...(item.options as M3u8DLOptions), retryFailedOnly: true });
        count++;
      }
      res.json({ code: 0, message: count ? `已重试 ${count} 个任务的失败分片` : '没有可重试的失败分片' });
    });
    app.get('/api/queue/status', (_req, res) =>
      res.json({
        code: 0,
        data: {
          queueLength: [...this.tasks.values()].filter(item => item.status === 'pending').length,
          activeDownloads: [...this.runs.keys()],
          maxConcurrent: this.cfg.maxDownloads,
        },
      })
    );
    app.post('/api/cat-catch', async (req, res) => {
      if (!this.token.trim()) {
        res.status(403).json({ code: 1, message: '请先设置下载器访问密码（DS_SECRET），再启用猫抓发送' });
        return;
      }
      if (this.closing) throw new Error('服务正在关闭');
      const list = catCatchTasks(req.body);
      let added = 0;
      for (const { url, ...options } of list) {
        if (this.tasks.get(url)?.status === 'pending') continue;
        if (await this.enqueue(url, options)) added++;
      }
      res.json({ code: 0, message: `已加入 ${added} 个下载任务`, data: { added, skipped: list.length - added } });
    });
    app.post('/api/download', async (req, res) => {
      const list = req.body.list;
      if (!Array.isArray(list) || !list.length || list.length > 100) throw new Error('每次请添加 1–100 个下载链接');
      // Validate the entire batch before creating tasks.
      for (const item of list) {
        sourceUrl(item.url);
        if (item.sourceUrl) normalizeDownloadUrl(item.sourceUrl);
        if (item.headerSourceUrl) normalizeDownloadUrl(item.headerSourceUrl);
        formatHeaders(item.headers);
        await formatOptions(item.url, item);
      }
      for (const { url, ...options } of list) await this.enqueue(url, options);
      res.json({ code: 0, message: '已加入下载队列' });
    });
    app.post('/api/pause', async (req, res) => {
      const urls: string[] = req.body.all ? [...this.tasks.keys()] : req.body.urls || [];
      const stopping: Promise<void>[] = [];
      for (const url of urls) {
        const item = this.tasks.get(url);
        if (!item || !['resume', 'pending'].includes(item.status)) continue;
        item.status = 'pause';
        const run = this.runs.get(url);
        run?.controller.abort();
        if (run) stopping.push(run.completion);
      }
      this.broadcast(true);
      this.persist();
      await Promise.allSettled(stopping);
      res.json({ code: 0, message: '已暂停，分片缓存已保留' });
    });
    app.post('/api/resume', async (req, res) => {
      const urls: string[] = req.body.all ? [...this.tasks.keys()] : req.body.urls || [];
      for (const url of urls) {
        const item = this.tasks.get(url);
        if (item && ['pause', 'error'].includes(item.status)) await this.enqueue(url, item.options as M3u8DLOptions, item.browserCapture);
      }
      res.json({ code: 0, message: '已继续下载' });
    });
    app.post('/api/delete', async (req, res) => {
      for (const url of req.body.urls || []) {
        const item = this.tasks.get(url);
        if (!item) continue;
        this.tasks.delete(url);
        const run = this.runs.get(url);
        run?.controller.abort();
        if (run) await run.completion;
        if (req.body.deleteCache) {
          const target = resolve(this.cacheDir, md5(url));
          if (target !== this.cacheDir && target.startsWith(`${this.cacheDir}${sep}`))
            await fs.rm(target, { recursive: true, force: true });
        }
        if (req.body.deleteVideo && item.localVideo)
          await fs.unlink(item.localVideo).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
      }
      this.persist();
      this.broadcast(true);
      this.startNext();
      res.json({ code: 0, message: '任务已移除' });
    });
    app.get('/api/file', async (req, res) => {
      const item = this.tasks.get(String(req.query.url));
      if (item?.status !== 'done' || !item.localVideo || !(await checkFileExists(item.localVideo))) {
        res.status(404).json({ code: 1, message: '文件不存在或尚未完成合并' });
        return;
      }
      res.download(resolve(item.localVideo), basename(item.localVideo));
    });
  }
  async close() {
    this.closing = true;
    this.rssBridge.close();
    for (const controller of this.extractions) controller.abort();
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.allSettled([...this.runs.values()].map(run => run.completion));
    clearTimeout(this.saveTimer);
    clearTimeout(this.broadcastTimer);
    await this.flush();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>(done => this.server.close(() => done()));
  }
}

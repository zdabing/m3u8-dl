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
import type { SegmentSnapshot, ServerConfig, TaskItem } from '../types/contract.js';
import type { M3u8DLOptions } from '../types/m3u8.js';
import { VideoParser } from '../video-parser/index.js';
import { sourceUrl } from '../video-parser/platform.js';

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
  };
  constructor(options: DLServerOptions = {}) {
    this.cacheDir = resolve(options.cacheDir || process.env.DS_CACHE_DIR || resolve(homedir(), '.m3u8-dl/cache'));
    this.configPath = options.configPath || resolve(this.cacheDir, 'config.json');
    this.token = options.token || process.env.DS_SECRET || process.env.DS_TOKEN || '';
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
    await initProxy(this.cfg);
    this.app.use(express.json({ limit: '1mb' }));
    this.app.get('/healthcheck', (_req, res) => res.json({ code: 0, message: 'ok' }));
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
  private async enqueue(input: string, options: M3u8DLOptions = {}) {
    const url = sourceUrl(input);
    const existing = this.tasks.get(url);
    if (this.runs.has(url) || existing?.status === 'done') return;
    const merged = { ...existing?.options, ...options } as M3u8DLOptions;
    const formatted = await formatOptions(url, { ...this.cfg, ...merged });
    if (!existing) {
      const original = formatted.options.filename;
      const extension = extname(original);
      let suffix = 1;
      while (
        [...this.tasks.values()].some(task => task.filename === formatted.options.filename) ||
        (await checkFileExists(resolve(formatted.options.saveDir, formatted.options.filename)))
      ) {
        formatted.options.filename = `${basename(original, extension)} (${++suffix})${extension}`;
      }
    }
    const item: TaskItem = {
      ...existing,
      url,
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
    this.tasks.set(url, item);
    this.persist();
    this.broadcast(true);
    this.startNext();
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
      const headers = { ...formatHeaders(this.cfg.headers), ...formatHeaders(options?.headers) };
      const result = await downloadResource(item.url, {
        ...this.cfg,
        ...options,
        headers,
        cacheDir: this.cacheDir,
        convert: true,
        signal: controller.signal,
        onProgress: (_finished, _total, _current, stats) => {
          if (!this.tasks.has(item.url) || controller.signal.aborted) return false;
          Object.assign(item, stats);
          this.broadcast();
          this.persist();
          return true;
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
      await initProxy(next);
      await fs.mkdir(dirname(this.configPath), { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(next, null, 2));
      this.cfg = next;
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
        if (item?.status !== 'error' || this.runs.has(url)) continue;
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
        if (item && ['pause', 'error'].includes(item.status)) await this.enqueue(url, item.options as M3u8DLOptions);
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

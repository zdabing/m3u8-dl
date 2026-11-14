import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { captureBrowserHls } from '../lib/browser-capture.js';
import { m3u8Convert } from '../lib/m3u8-convert.js';
import { normalizeDownloadUrl } from '../lib/utils.js';
import type { DownloadStats } from '../types/contract.js';
import type { M3u8DLOptions } from '../types/m3u8.js';

export function browserCaptureConfig(env = process.env) {
  const { DS_BROWSER_ENDPOINT, DS_BROWSER_WINDOW, DS_BROWSER_ORIGINS } = env;
  if (!DS_BROWSER_ENDPOINT || !DS_BROWSER_WINDOW || !DS_BROWSER_ORIGINS?.trim()) return undefined;
  const origins = new Set(DS_BROWSER_ORIGINS.split(',').map(value => new URL(normalizeDownloadUrl(value)).origin));
  const endpoint = new URL(DS_BROWSER_ENDPOINT);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('浏览器服务地址必须使用 ws 或 wss');
  return { endpoint: endpoint.href, viewer: normalizeDownloadUrl(DS_BROWSER_WINDOW), origins };
}

export function validateBrowserSource(config: ReturnType<typeof browserCaptureConfig>, input: unknown) {
  if (!config) throw new Error('未启用浏览器保存');
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请输入有效的播放页面链接');
  const url = new URL(normalizeDownloadUrl(input));
  if (!config.origins.has(url.origin)) throw new Error('该播放页来源未启用浏览器保存');
  return url.href;
}

export async function runBrowserCapture(
  config: ReturnType<typeof browserCaptureConfig>,
  url: string,
  cacheDir: string,
  options: M3u8DLOptions,
  progress: (stats: Partial<DownloadStats>) => void
) {
  validateBrowserSource(config, url);
  const signal = options.signal;
  signal?.throwIfAborted();
  const attempt = resolve(cacheDir, randomUUID());
  progress({ phase: 'parsing', startTime: Date.now(), endTime: 0, progress: 0, tsCount: 0, tsSuccess: 0, tsFailed: 0, downloadedSize: 0 });
  const browser = await chromium.connect(config.endpoint, { timeout: 12_000 }).catch(() => {
    throw new Error('无法连接独立浏览器服务');
  });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: null });
    await context.route('**/*', route =>
      config.origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient')
    );
    await context.routeWebSocket(/.*/, socket => socket.close());
    const page = await context.newPage();
    const stop = new AbortController();
    const timeout = setTimeout(() => stop.abort(new Error('浏览器保存超时，已收到的分片仍在缓存目录')), 12 * 60 * 60 * 1000);
    const captureSignal = signal ? AbortSignal.any([stop.signal, signal]) : stop.signal;
    const segments = captureBrowserHls(context, config.origins, attempt, captureSignal, (total, captured, bytes) => {
      progress({ phase: 'downloading', tsCount: total, tsSuccess: captured, downloadedSize: bytes, progress: Math.floor((99 * captured) / total) });
    });
    const closePage = () => stop.abort(new Error('浏览器播放页已关闭，已收到的分片仍在缓存目录'));
    page.on('close', closePage);
    try {
      const [, files] = await Promise.all([
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {
          captureSignal.throwIfAborted();
          throw new Error('独立浏览器无法打开播放页');
        }),
        segments,
      ]);
      progress({ phase: 'merging' });
      const filepath = await m3u8Convert({ ...options, onMergeProgress: (mergeProgress, mergeMessage) => progress({ mergeProgress, mergeMessage }) }, files);
      if (options.delCache) await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
      return { filepath, paused: false, errmsg: '' };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = (error as Error).message;
      if (message.includes('已收到的分片') || message.includes('已保存的分片')) throw error;
      throw new Error(`${message}。已收到的分片会保留在缓存目录`, { cause: error });
    } finally {
      clearTimeout(timeout);
      stop.abort();
      page.off('close', closePage);
      await context.close().catch(() => {});
      await segments.catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

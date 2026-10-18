import type { OutgoingHttpHeaders } from 'node:http';
import { activeDownloads } from '../lib/download-control.js';
import { fileDownload } from '../lib/file-download.js';
import { m3u8Download } from '../lib/m3u8-download.js';
import { headersForTarget } from '../lib/utils.js';
import type { ApiResponse, VideoInfo } from '../types/contract.js';
import type { M3u8DLOptions, M3u8DLProgressStats, M3u8DLResult } from '../types/m3u8.js';
import { DouyinParser } from './parsers/douyin-parser.js';
import { PipixiaParser } from './parsers/pipixia-parser.js';
import { WeiboParser } from './parsers/weibo-parser.js';
import { detectPlatform, sourceUrl } from './platform.js';
import type { ParserContext } from './request.js';

const parsers = { douyin: DouyinParser, pipixia: PipixiaParser, weibo: WeiboParser };
export class VideoParser {
  static getPlatform = detectPlatform;
  static getSupportedPlatforms() {
    return Object.keys(parsers);
  }
  static async parse(input: string, headers?: OutgoingHttpHeaders | string, context: ParserContext = {}): Promise<ApiResponse<VideoInfo>> {
    const info = detectPlatform(input);
    const parser = parsers[info.platform as keyof typeof parsers];
    if (!parser) return { code: 1, message: info.errmsg || '支持抖音、微博、皮皮虾；其他播放页面请使用网页提取' };
    context.signal?.throwIfAborted();
    return parser.parse(info.url, headers, context);
  }
  static async download(input: string, options: M3u8DLOptions = {}): Promise<M3u8DLResult> {
    const url = sourceUrl(input);
    if (activeDownloads.has(url)) throw new Error('该链接正在解析或下载，请先暂停现有任务');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    activeDownloads.set(url, controller);
    try {
      const stats: M3u8DLProgressStats = {
        url,
        downloadType: 'file',
        phase: 'parsing',
        startTime: Date.now(),
        progress: 0,
        tsCount: 0,
        tsSuccess: 0,
        tsFailed: 0,
        duration: 0,
        durationDownloaded: 0,
        downloadedSize: 0,
        avgSpeed: 0,
        avgSpeedDesc: '',
        speed: 0,
        speedDesc: '',
        remainingTime: 0,
        filename: options.filename,
      };
      if (options.onProgress?.(0, 0, null, stats) === false) controller.abort();
      signal.throwIfAborted();
      const parsed = await VideoParser.parse(url, options.headers, { signal });
      signal.throwIfAborted();
      if (parsed.code || !parsed.data?.url) return { errmsg: parsed.message || '平台解析失败', options, stats };
      const info = parsed.data;
      if (info.url === url) throw new Error('平台未返回独立的视频直链');
      const requestHeaders = headersForTarget(info.referer || url, info.url, options.headers);
      const isHls = /\.m3u8$/i.test(new URL(info.url).pathname);
      const downloader = isHls ? m3u8Download : fileDownload;
      const result = await downloader(
        info.url,
        {
          ...options,
          type: isHls ? 'm3u8' : 'file',
          signal,
          headers: requestHeaders,
          filename: options.filename || (info.title ? `${info.title.slice(0, 120)}.mp4` : undefined),
          onInited: (value, ...args) => options.onInited?.({ ...value, url }, ...args),
          onProgress: (count, total, current, value) => options.onProgress?.(count, total, current, { ...value, url }),
        },
        url
      );
      if (result.stats) result.stats.url = url;
      return result;
    } catch (error) {
      if (signal.aborted) return { paused: true, options };
      return { errmsg: (error as Error).message, options };
    } finally {
      activeDownloads.delete(url);
    }
  }
}

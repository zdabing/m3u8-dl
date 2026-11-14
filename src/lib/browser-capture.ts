import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { Parser } from 'm3u8-parser';
import type { BrowserContext, Response } from 'playwright-core';
import type { TsItemInfo } from '../types/m3u8.js';

const maxManifestBytes = 2 * 1024 * 1024;
const maxSegmentBytes = 64 * 1024 * 1024;
const maxCaptureBytes = 16 * 1024 * 1024 * 1024;

export function captureBrowserHls(
  context: BrowserContext,
  origins: ReadonlySet<string>,
  cacheDir: string,
  signal: AbortSignal,
  onProgress: (total: number, captured: number, bytes: number) => void
): Promise<TsItemInfo[]> {
  return new Promise((done, fail) => {
    const byUrl = new Map<string, TsItemInfo>();
    let segments: TsItemInfo[] = [];
    let count = 0;
    let bytes = 0;
    let pending = 0;
    let settled = false;
    let queue = Promise.resolve();

    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      context.off('response', onResponse);
      context.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      if (error) fail(error);
      else done(segments);
    }
    function onClose() {
      void queue.finally(() => finish(new Error('浏览器已关闭，已保存的分片仍在缓存目录')));
    }
    function onAbort() {
      void context
        .close()
        .catch(() => {})
        .then(() => queue)
        .finally(() => finish(signal.reason));
    }
    async function readPlaylist(response: Response) {
      const body = await response.body();
      if (body.length > maxManifestBytes) throw new Error('播放列表超过大小限制');
      const text = body.toString('utf8');
      if (!text.trimStart().startsWith('#EXTM3U')) return;
      if (/^#EXT-X-MEDIA:(?=.*\bTYPE=AUDIO\b)(?=.*\bURI=)/im.test(text)) throw new Error('浏览器保存暂不支持独立音轨');
      const parser = new Parser();
      parser.push(text);
      parser.end();
      if (!parser.manifest.segments?.length) return;
      if (!parser.manifest.endList) throw new Error('浏览器保存目前需要带结束标记的点播列表');
      if (parser.manifest.segments.length > 20_000) throw new Error('播放列表分片数量超过限制');
      segments = parser.manifest.segments.map((segment, index) => {
        if (segment.key || segment.map || segment.byterange || segment.discontinuity) {
          throw new Error('浏览器保存目前仅支持连续、未加密的 MPEG-TS 分片');
        }
        const resource = new URL(segment.uri, response.url());
        resource.hash = '';
        if (resource.username || resource.password || !origins.has(resource.origin) || byUrl.has(resource.href)) {
          throw new Error('播放列表含重复分片地址或未配置的媒体来源');
        }
        const item = {
          index,
          duration: segment.duration,
          timeline: segment.timeline || 0,
          uri: resource.href,
          m3u8: response.url(),
          tsOut: resolve(cacheDir, `${index}.ts`),
        };
        byUrl.set(resource.href, item);
        return item;
      });
      await fs.mkdir(cacheDir, { recursive: true });
      onProgress(segments.length, count, bytes);
    }
    async function readSegment(response: Response, item: TsItemInfo) {
      if (item.tsSize) return;
      const body = await response.body();
      signal.throwIfAborted();
      if (body.length > maxSegmentBytes || bytes + body.length > maxCaptureBytes) throw new Error('浏览器分片保存超过大小限制');
      if (body.length < 564 || body.length % 188 || body[0] !== 0x47 || body[188] !== 0x47 || body[376] !== 0x47) return;
      const temporary = `${item.tsOut}.part`;
      try {
        await fs.writeFile(temporary, body, { signal });
        await fs.rename(temporary, item.tsOut);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      item.tsSize = body.length;
      bytes += body.length;
      onProgress(segments.length, ++count, bytes);
      if (count === segments.length) finish();
    }
    function onResponse(response: Response) {
      if (settled || signal.aborted || response.status() !== 200 || response.request().method() !== 'GET') return;
      const url = new URL(response.url());
      if (!origins.has(url.origin)) return;
      const headers = response.headers();
      const manifest = /\.m3u8$/i.test(url.pathname) || /mpegurl/i.test(headers['content-type'] || '');
      const media = /\.ts$/i.test(url.pathname) || /video\/mp2t/i.test(headers['content-type'] || '') || byUrl.has(url.href);
      if ((!manifest || segments.length) && !media) return;
      if (Number(headers['content-length']) > (manifest ? maxManifestBytes : maxSegmentBytes)) {
        finish(new Error('浏览器播放列表或分片超过大小限制'));
        return;
      }
      if (++pending > 64) {
        finish(new Error('浏览器分片处理积压，请重新从头播放'));
        return;
      }
      queue = queue
        .then(async () => {
          if (settled) return;
          signal.throwIfAborted();
          if (manifest && !segments.length) await readPlaylist(response);
          else {
            const item = byUrl.get(url.href);
            if (item) await readSegment(response, item);
          }
        })
        .catch(error => finish(signal.aborted ? signal.reason : error))
        .finally(() => {
          pending--;
        });
    }
    if (signal.aborted) finish(signal.reason);
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      context.on('close', onClose);
      context.on('response', onResponse);
    }
  });
}

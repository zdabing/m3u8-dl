import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { M3u8DLOptions, M3u8DLProgressStats, M3u8DLResult } from '../types/m3u8.js';
import { activeDownloads } from './download-control.js';
import { formatOptions } from './format-options.js';
import { checkFileExists, formatByteSize, formatHeaders, getResponse, HttpError, md5 } from './utils.js';

/** Raised when a direct-file URL actually returns an HLS playlist, so the caller can retry as HLS. */
export class PlaylistResponse extends Error {}
interface FileState {
  url: string;
  etag?: string;
  modified?: string;
  total?: number;
}
/** What this URL published next to the output, so a same-named file from another link never matches. */
interface PublishedMarker {
  url: string;
  size: number;
  etag?: string;
  modified?: string;
}
class RestartDownload extends Error {}

/** Download a direct file without buffering it or passing it through FFmpeg. */
export async function fileDownload(input: string, supplied: M3u8DLOptions = {}, sourceIdentity?: string): Promise<M3u8DLResult> {
  const { url, options } = await formatOptions(input, { ...supplied, type: 'file' });
  const urlMd5 = md5(sourceIdentity || url);
  if (activeDownloads.has(url)) throw new Error('该链接正在下载，请先暂停现有任务');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  activeDownloads.set(url, controller);
  const cacheDir = resolve(options.cacheDir, urlMd5);
  const partial = resolve(cacheDir, 'download.part');
  const statePath = resolve(cacheDir, 'file.json');
  const target = resolve(options.saveDir, options.filename);
  const stats: M3u8DLProgressStats = {
    url,
    filename: options.filename,
    downloadType: 'file',
    phase: 'downloading',
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
  };
  const result: M3u8DLResult = { options, stats };
  let response: IncomingMessage;
  let timer: ReturnType<typeof setInterval>;
  let previousBytes = 0;
  let previousTime = Date.now();
  let transferred = 0;
  const report = () => {
    const now = Date.now();
    stats.speed = Math.max(0, ((stats.downloadedSize - previousBytes) * 1000) / Math.max(1, now - previousTime));
    stats.speedDesc = `${formatByteSize(stats.speed)}/s`;
    stats.avgSpeed = (transferred * 1000) / Math.max(1, now - stats.startTime);
    stats.avgSpeedDesc = `${formatByteSize(stats.avgSpeed)}/s`;
    stats.progress =
      stats.phase === 'done' ? 100 : stats.size ? Number(Math.min(99, (stats.downloadedSize * 100) / stats.size).toFixed(1)) : 0;
    stats.remainingTime = stats.size && stats.speed ? Math.ceil((stats.size - stats.downloadedSize) / stats.speed) : 0;
    previousBytes = stats.downloadedSize;
    previousTime = now;
    if (options.onProgress?.(stats.downloadedSize, stats.size || 0, null, { ...stats }) === false) controller.abort();
  };
  try {
    signal.throwIfAborted();
    // The marker records what this URL published, so a same-named file from another link cannot match.
    const marker = resolve(options.saveDir, `.${options.filename}.${urlMd5}.json`);
    if (!options.force && (await checkFileExists(target))) {
      const published: PublishedMarker | undefined = await fs.readFile(marker, 'utf8').then(
        (text): PublishedMarker => JSON.parse(text),
        (): undefined => undefined
      );
      const info = await fs.stat(target);
      const resumable = await fs.stat(partial).then(
        () => true,
        () => false
      );
      if (published?.url === url && !resumable && published.size === info.size) {
        stats.downloadedSize = stats.size = info.size;
        stats.phase = 'done';
        report();
        return { ...result, filepath: target, isExist: true };
      }
    }
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(options.saveDir, { recursive: true });
    let state: FileState;
    try {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch {
      /* First request. */
    }
    let offset = await fs.stat(partial).then(
      info => info.size,
      () => 0
    );
    // Without a validator, concatenating two representations could silently corrupt a video.
    if (state?.url !== url || !(state.etag || state.modified)) offset = 0;
    if (!offset)
      await fs.truncate(partial, 0).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    // A file that cannot be proven to be ours is replaced atomically once the new bytes are complete.
    options.onInited?.(stats, null, signal);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const headers = formatHeaders(options.headers);
        // File ranges belong to the downloader, not a stale custom request header.
        delete headers.range;
        delete headers['if-range'];
        if (offset) {
          headers.range = `bytes=${offset}-`;
          headers['if-range'] = state.etag || state.modified;
        }
        ({ response } = await getResponse(url, headers, signal));
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') throw new Error('直链下载要求服务器返回未压缩内容');
        if (
          /text\/html|application\/(?:problem\+)?json/i.test(String(response.headers['content-type'] || '')) &&
          /\.(mp4|vtt|mkv|webm|mov|srt)$/i.test(options.filename)
        )
          throw new Error('服务器返回了网页或错误信息，请检查链接、Referer 和 Cookie');
        const lengthHeader = response.headers['content-length'];
        const length = lengthHeader === undefined ? undefined : Number(lengthHeader);
        if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new Error('服务器文件长度无效');
        // An extensionless CDN link can serve a playlist; storing its text as video would be silent corruption.
        if (/mpegurl/i.test(String(response.headers['content-type'] || ''))) throw new PlaylistResponse('该地址返回的是 HLS 播放列表');
        let total = length;
        if (response.statusCode === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
          if (
            !range ||
            Number(range[1]) !== offset ||
            Number(range[2]) < offset ||
            Number(range[2]) + 1 !== Number(range[3]) ||
            (length !== undefined && length !== Number(range[2]) - offset + 1) ||
            (offset && state.total !== undefined && state.total !== Number(range[3])) ||
            (offset && state.etag && response.headers.etag && state.etag !== response.headers.etag) ||
            (offset &&
              !state.etag &&
              state.modified &&
              response.headers['last-modified'] &&
              state.modified !== response.headers['last-modified'])
          )
            throw new RestartDownload('服务器返回了不匹配的续传范围，已放弃旧缓存');
          total = Number(range[3]);
          if (!Number.isSafeInteger(total) || total <= 0) throw new Error('服务器续传文件长度无效');
        } else if (response.statusCode === 200) {
          // A server may ignore Range or return a changed representation after If-Range.
          offset = 0;
          await fs.writeFile(partial, '');
        } else throw new Error(`直链响应状态不支持: ${response.statusCode}`);
        const etag = response.headers.etag && !response.headers.etag.startsWith('W/') ? response.headers.etag : undefined;
        state = {
          url,
          total,
          etag,
          modified: response.headers['last-modified'],
        };
        // Commit metadata before writing bytes; a crash can only leave a resumable prefix.
        await fs.writeFile(`${statePath}.part`, JSON.stringify(state));
        await fs.rename(`${statePath}.part`, statePath);
        stats.size = total;
        stats.downloadedSize = offset;
        previousBytes = offset;
        previousTime = Date.now();
        report();
        signal.throwIfAborted();
        timer = setInterval(report, 500);
        const counter = new Transform({
          transform(chunk, _encoding, done) {
            stats.downloadedSize += chunk.length;
            transferred += chunk.length;
            if (total !== undefined && stats.downloadedSize > total) done(new Error('下载内容超出服务器声明的长度'));
            else done(null, chunk);
          },
        });
        await pipeline(response, counter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal });
        clearInterval(timer);
        if (total !== undefined && stats.downloadedSize !== total) throw new Error('文件尚未下载完整，缓存已保留');
        if (!stats.downloadedSize) throw new Error('服务器返回了空文件');
        signal.throwIfAborted();
        // Rename within the output directory also works when cache and output use different drives.
        const publishing = resolve(options.saveDir, `.${urlMd5}.download.part`);
        // The marker lives next to the output so delCache can keep the cache directory empty.
        const marker = resolve(options.saveDir, `.${options.filename}.${urlMd5}.json`);
        try {
          await pipeline(createReadStream(partial), createWriteStream(publishing), { signal });
          signal.throwIfAborted();
          // rename replaces an unproven same-named file atomically, so a failure never leaves it truncated.
          await fs.rename(publishing, target);
          await fs.writeFile(
            marker,
            JSON.stringify({ url, size: stats.downloadedSize, etag, modified: state.modified } satisfies PublishedMarker)
          );
        } finally {
          await fs.rm(publishing, { force: true });
        }
        // The marker in the output directory is what proves a later run may reuse this file.
        if (options.delCache) await fs.rm(cacheDir, { recursive: true, force: true });
        stats.phase = 'done';
        stats.endTime = Date.now();
        stats.size = stats.downloadedSize;
        report();
        return { ...result, filepath: target };
      } catch (error) {
        response?.destroy();
        clearInterval(timer);
        signal.throwIfAborted();
        const restart = error instanceof RestartDownload || (error instanceof HttpError && error.status === 416);
        if (restart) {
          offset = 0;
          state = undefined;
          await fs.truncate(partial, 0).catch(() => {});
        }
        // Match the HLS path: 3 retries with the same capped exponential backoff.
        if (attempt >= 3 || (error instanceof HttpError && error.status < 500 && error.status !== 429 && !restart)) throw error;
        offset =
          state?.etag || state?.modified
            ? await fs.stat(partial).then(
                info => info.size,
                () => 0
              )
            : 0;
        await delay(Math.min(500 * 2 ** attempt, 3000), undefined, { signal });
      }
    }
  } catch (error) {
    if (signal.aborted) result.paused = true;
    else {
      result.errmsg = (error as Error).message || String(error);
      stats.errmsg = result.errmsg;
    }
    return result;
  } finally {
    response?.destroy();
    clearInterval(timer);
    activeDownloads.delete(url);
  }
}

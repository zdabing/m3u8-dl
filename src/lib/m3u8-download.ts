import { existsSync, promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SegmentProgress, SegmentSnapshot } from '../types/contract.js';
import type { M3u8DLOptions, M3u8DLProgressStats, M3u8DLResult } from '../types/m3u8.js';
import { activeDownloads as active } from './download-control.js';
import { formatOptions } from './format-options.js';
import { m3u8Convert } from './m3u8-convert.js';
import { parseM3U8 } from './parseM3u8.js';
import { tsDownload } from './ts-download.js';
import { formatByteSize, logger, md5 } from './utils.js';

export function m3u8DLStop(url: string) {
  active.get(url)?.abort();
}

export async function m3u8Download(input: string, supplied: M3u8DLOptions = {}, sourceIdentity?: string): Promise<M3u8DLResult> {
  const { url, options } = await formatOptions(input, { ...supplied, type: 'm3u8' });
  const urlMd5 = md5(sourceIdentity || url);
  if (active.has(url)) throw new Error('该链接正在下载，请先暂停现有任务');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  active.set(url, controller);
  options.signal = signal;
  const cacheDir = resolve(options.cacheDir, urlMd5);
  const result: M3u8DLResult = { options };
  const statePath = resolve(cacheDir, 'segments.json');
  let segmentState: SegmentSnapshot;
  let saveTimer: NodeJS.Timeout;
  let tick: NodeJS.Timeout;
  let saveQueue = Promise.resolve();
  let cacheRemoved = false;
  const flushSegments = () => {
    if (!segmentState) return saveQueue;
    const json = JSON.stringify(segmentState);
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(`${statePath}.part`, json);
        await fs.rename(`${statePath}.part`, statePath);
      });
    return saveQueue;
  };
  const saveSegments = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void flushSegments().catch(error => logger.warn('分片状态保存失败:', error));
    }, 500);
  };
  const stats: M3u8DLProgressStats = {
    downloadType: 'm3u8',
    url,
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
    threadNum: options.threadNum,
  };
  result.stats = stats;
  const report = () => {
    if (options.onProgress?.(stats.tsSuccess + stats.tsFailed, stats.tsCount, null, { ...stats }) === false) controller.abort();
  };
  try {
    const existing = resolve(options.saveDir, options.filename);
    if (!options.force && existsSync(existing)) return { ...result, filepath: existing, isExist: true };
    report();
    const info = await parseM3U8(url, cacheDir, options.headers, signal);
    result.m3u8Info = info;
    if (options.ignoreSegments) {
      const ranges = options.ignoreSegments.split(',').map(range => {
        const end = /^END-(\d+(?:\.\d+)?)$/i.exec(range.trim());
        if (end) return [Math.max(0, info.duration - Number(end[1])), info.duration];
        return range.split('-').map(Number);
      });
      let timeline = 0;
      info.data = info.data.filter(segment => {
        const midpoint = timeline + segment.duration / 2;
        timeline += segment.duration;
        return !ranges.some(([start, end]) => midpoint >= start && midpoint <= end);
      });
      info.tsCount = info.data.length;
      info.duration = info.data.reduce((sum, segment) => sum + segment.duration, 0);
    }
    if (!info.tsCount) throw new Error('过滤后没有可下载的视频分片');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(resolve(cacheDir, 'info.json'), JSON.stringify({ url, filename: options.filename }));
    const fingerprint = md5(info.data.map(segment => `${segment.uri}@${JSON.stringify(segment.byterange || null)}`).join('\n'));
    let previous: SegmentSnapshot;
    try {
      previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch {
      /* No earlier attempt. */
    }
    if (options.retryFailedOnly && (!previous || previous.fingerprint !== fingerprint)) {
      throw new Error('缺少匹配的失败分片记录，或播放列表已变化，请使用继续下载');
    }
    const previousItems = previous?.fingerprint === fingerprint ? previous.items : [];
    const failed = new Set(previousItems.filter(item => item.status === 'error').map(item => item.index));
    if (options.retryFailedOnly && !failed.size) throw new Error('没有需要重试的失败分片');
    const items: SegmentProgress[] = [];
    const queue: number[] = [];
    let completedBytes = 0;
    for (const [index, segment] of info.data.entries()) {
      signal.throwIfAborted();
      const size = await fs.stat(segment.tsOut).then(
        stat => stat.size,
        () => 0
      );
      const cached = size > 0;
      if (options.retryFailedOnly && !failed.has(index) && !cached) throw new Error(`第 ${index + 1} 个分片缓存缺失，请使用继续下载`);
      items.push({ index, status: cached ? 'done' : 'pending', size, attempts: previousItems[index]?.attempts || 0 });
      if (cached) {
        segment.tsSize = size;
        completedBytes += size;
        stats.tsSuccess++;
        stats.durationDownloaded += segment.duration;
      } else queue.push(index);
    }
    segmentState = { fingerprint, items };
    await flushSegments();
    Object.assign(stats, { phase: 'downloading', tsCount: info.tsCount, duration: info.duration, hasSegmentDetails: true });
    const partial = new Map<number, number>();
    const lastReceived = new Map<number, number>();
    let networkBytes = 0;
    const samples = [{ time: Date.now(), bytes: 0 }];
    const refresh = () => {
      const now = Date.now();
      samples.push({ time: now, bytes: networkBytes });
      while (samples.length > 2 && samples[1].time < now - 3000) samples.shift();
      const first = samples[0];
      stats.speed = Math.max(0, ((networkBytes - first.bytes) * 1000) / Math.max(1, now - first.time));
      stats.speedDesc = `${formatByteSize(stats.speed)}/s`;
      stats.downloadedSize = completedBytes + [...partial.values()].reduce((sum, value) => sum + value, 0);
      stats.progress = Math.min(99, Math.floor((stats.tsSuccess / stats.tsCount) * 100));
      stats.remainingTime = stats.tsSuccess
        ? Math.ceil(((now - stats.startTime) / 1000 / stats.tsSuccess) * (stats.tsCount - stats.tsSuccess))
        : 0;
    };
    options.onInited?.(stats, info, signal);
    refresh();
    report();
    tick = setInterval(() => {
      if (stats.phase !== 'downloading' || signal.aborted) return;
      refresh();
      report();
      saveSegments();
    }, 500);
    let cursor = 0;
    const errors: string[] = [];
    const worker = async () => {
      while (cursor < queue.length && !signal.aborted) {
        const index = queue[cursor++];
        const segment = info.data[index];
        const state = items[index];
        let failure: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          state.status = 'downloading';
          state.attempts++;
          state.error = undefined;
          saveSegments();
          try {
            await tsDownload(
              segment,
              info.crypto[segment.keyUri]
                ? { ...info.crypto[segment.keyUri], iv: segment.iv || info.crypto[segment.keyUri].iv }
                : undefined,
              options.headers,
              signal,
              received => {
                const delta = received - (lastReceived.get(index) || 0);
                if (delta > 0) networkBytes += delta;
                lastReceived.set(index, received);
                partial.set(index, received);
                state.size = received;
              }
            );
            failure = undefined;
            break;
          } catch (error) {
            if (signal.aborted) {
              state.status = 'pending';
              state.size = 0;
              partial.delete(index);
              throw error;
            }
            failure = error;
            if (attempt < 2) await delay(1000 * (attempt + 1), undefined, { signal });
          }
        }
        partial.delete(index);
        if (failure) {
          stats.tsFailed++;
          state.status = 'error';
          state.size = 0;
          state.error = (failure as Error).message;
          errors.push(state.error);
        } else {
          state.status = 'done';
          state.size = segment.tsSize;
          stats.tsSuccess++;
          completedBytes += segment.tsSize;
          stats.durationDownloaded += segment.duration;
        }
        refresh();
        report();
        saveSegments();
      }
    };
    const workers = Array.from({ length: Math.min(options.threadNum, queue.length) }, worker);
    const settled = await Promise.allSettled(workers);
    signal.throwIfAborted();
    const rejected = settled.find(item => item.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    await flushSegments();
    if (stats.tsFailed) throw new Error(`${stats.tsFailed} 个分片下载失败，可继续下载重试。${errors[0] || ''}`);
    if (options.convert !== false) {
      stats.phase = 'merging';
      stats.speed = 0;
      stats.speedDesc = '';
      stats.remainingTime = 0;
      report();
      const onMergeProgress = options.onMergeProgress;
      result.filepath = await m3u8Convert(
        {
          ...options,
          onMergeProgress: (progress, message) => {
            stats.mergeProgress = progress;
            stats.mergeMessage = message;
            report();
            onMergeProgress?.(progress, message);
          },
        },
        info
      );
      if (!result.filepath || !existsSync(result.filepath)) throw new Error('合并失败，分片缓存已保留，可继续任务重试');
      stats.size = (await fs.stat(result.filepath)).size;
      if (options.delCache) {
        // The directory is an md5 child of the configured cache root.
        if (cacheDir !== resolve(options.cacheDir) && cacheDir.startsWith(`${resolve(options.cacheDir)}${sep}`)) {
          clearTimeout(saveTimer);
          await saveQueue;
          await fs.rm(cacheDir, { recursive: true, force: true });
          cacheRemoved = true;
        }
      }
    }
    stats.phase = 'done';
    stats.progress = 100;
    stats.mergeProgress = 100;
    report();
    return result;
  } catch (error) {
    if (signal.aborted) result.paused = true;
    else {
      result.errmsg = (error as Error).message || String(error);
      stats.errmsg = result.errmsg;
      logger.error(result.errmsg);
    }
    return result;
  } finally {
    clearInterval(tick);
    clearTimeout(saveTimer);
    if (segmentState && !cacheRemoved) {
      for (const item of segmentState.items)
        if (item.status === 'downloading') {
          item.status = 'pending';
          item.size = 0;
        }
      await flushSegments().catch(error => logger.warn('分片状态保存失败:', error));
    }
    active.delete(url);
  }
}

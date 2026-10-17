import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { M3u8DLOptions, M3u8Info, TsItemInfo } from '../types/m3u8.js';
import { detectContainerByFile } from './container.js';
import { runMediaProcess } from './merge-process.js';

const probes = new Map<string, Promise<boolean>>();
export function isSupportFfmpeg(binary = 'ffmpeg') {
  if (!probes.has(binary))
    probes.set(
      binary,
      new Promise<boolean>(done => {
        const process = spawn(binary, ['-version'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => {
          process.kill();
          done(false);
        }, 5000);
        process.once('error', () => {
          clearTimeout(timer);
          done(false);
        });
        process.once('close', code => {
          clearTimeout(timer);
          done(code === 0);
        });
      })
    );
  return probes.get(binary);
}
let merging = false;
const waiting: Array<() => void> = [];
async function acquire(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (merging)
    await new Promise<void>((done, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', abort);
        done();
      };
      const abort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(grant);
      signal?.addEventListener('abort', abort, { once: true });
    });
  merging = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else merging = false;
  };
}
/** Only inspect the first chunk; repair disguised TS headers without loading entire files. */
function repairPrefix(chunk: Buffer) {
  if (chunk[0] === 0x47) return chunk;
  const limit = Math.min(chunk.length - 376, 188 * 50);
  for (let offset = 1; offset < limit; offset++) {
    if (chunk[offset] === 0x47 && chunk[offset + 188] === 0x47 && chunk[offset + 376] === 0x47) return chunk.subarray(offset);
  }
  // Some TS sources replace just the first sync byte. Verify the other packets first.
  if (chunk[188] === 0x47 && chunk[376] === 0x47) chunk[0] = 0x47;
  return chunk;
}
async function* chunks(files: string[], repair: boolean, signal?: AbortSignal, onBytes?: (bytes: number) => void) {
  for (const file of files) {
    signal?.throwIfAborted();
    let first = true;
    const stream = createReadStream(file, { highWaterMark: 256 * 1024, signal });
    for await (const buffer of stream) {
      const data = first && repair ? repairPrefix(buffer as Buffer) : (buffer as Buffer);
      first = false;
      onBytes?.(data.length);
      yield data;
    }
  }
}
export async function m3u8Convert(options: M3u8DLOptions, supplied: M3u8Info | TsItemInfo[]) {
  const info: M3u8Info = Array.isArray(supplied)
    ? {
        data: supplied,
        tsCount: supplied.length,
        duration: supplied.reduce((sum, item) => sum + item.duration, 0),
        crypto: {},
        manifest: {},
        container: supplied[0]?.tsOut ? detectContainerByFile(supplied[0].tsOut) : 'ts',
      }
    : supplied;
  if (!info.data.length) throw new Error('没有可合并的视频分片');
  const signal = options.signal;
  options.onMergeProgress?.(0, merging ? '等待其他任务合并完成' : '准备合并');
  const release = await acquire(signal);
  let temporary = '';
  try {
    signal?.throwIfAborted();
    const fmp4 = info.container === 'fmp4';
    if (fmp4 && !info.initSegment?.tsOut) throw new Error('缺少 fMP4 初始化分片，无法合并；请检查来源链接或请求头');
    const files = [...(fmp4 ? [info.initSegment.tsOut] : []), ...info.data.map(segment => segment.tsOut)];
    let totalBytes = 0;
    for (const file of files) {
      signal?.throwIfAborted();
      const stat = await fs.stat(file);
      if (!stat.size) throw new Error(`分片文件为空: ${file}`);
      totalBytes += stat.size;
    }
    const binary = options.ffmpegPath || 'ffmpeg';
    const ffmpeg = await isSupportFfmpeg(binary);
    if (!ffmpeg && options.ffmpegPath) throw new Error('指定的 FFmpeg 无法运行，请检查下载设置中的路径');
    const extension = ffmpeg || fmp4 ? '.mp4' : '.ts';
    const rawName = options.filename || 'video';
    const filepath = resolve(options.saveDir || './downloads', `${rawName.slice(0, rawName.length - extname(rawName).length)}${extension}`);
    await fs.mkdir(dirname(filepath), { recursive: true });
    if (!options.force) {
      const exists = await fs.stat(filepath).then(
        () => true,
        () => false
      );
      if (exists) throw new Error('目标文件已存在，请更换文件名以免覆盖');
    }
    temporary = resolve(dirname(filepath), `.${randomUUID()}.part${extension}`);
    let lastReport = 0;
    let fed = 0;
    const report = (percent: number, message: string, force = false) => {
      if (force || Date.now() - lastReport > 300) {
        lastReport = Date.now();
        options.onMergeProgress?.(percent, message);
      }
    };
    const input = Readable.from(
      chunks(files, !fmp4, signal, bytes => {
        fed += bytes;
        if (!ffmpeg) report(Math.min(99, Math.floor((fed / totalBytes) * 100)), '正在顺序合并分片');
      })
    );
    if (ffmpeg) {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-stats_period',
        '1',
        '-progress',
        'pipe:1',
        '-fflags',
        '+genpts',
        ...(!fmp4 ? ['-f', 'mpegts'] : []),
        '-i',
        'pipe:0',
        '-map',
        '0:v?',
        '-map',
        '0:a?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        temporary,
      ];
      let lastTime = -1;
      let lastSize = '';
      await runMediaProcess(binary, args, input, {
        signal,
        idleTimeout: options.mergeTimeout || 180,
        onProgress: line => {
          const index = line.indexOf('=');
          const key = line.slice(0, index);
          const value = line.slice(index + 1);
          if (key === 'out_time_us') {
            const seconds = Math.max(0, Number(value) / 1_000_000);
            const changed = Number.isFinite(seconds) && seconds > lastTime;
            if (changed) {
              lastTime = seconds;
              report(Math.min(98, Math.floor((seconds / Math.max(1, info.duration)) * 100)), '正在无损封装视频');
            }
            return changed;
          }
          if (key === 'total_size') {
            const changed = value !== lastSize;
            lastSize = value;
            return changed;
          }
          if (key === 'progress' && value === 'end') {
            report(99, '正在完成文件写入', true);
            return true;
          }
          return false;
        },
      });
    } else await pipeline(input, createWriteStream(temporary), { signal });
    signal?.throwIfAborted();
    if (!(await fs.stat(temporary)).size) throw new Error('合并结果为空，缓存已保留');
    // Only a fully closed, successfully generated output becomes the final file.
    await fs.rename(temporary, filepath);
    temporary = '';
    report(100, '合并完成', true);
    return filepath;
  } finally {
    try {
      if (temporary) await fs.rm(temporary, { force: true });
    } finally {
      release();
    }
  }
}

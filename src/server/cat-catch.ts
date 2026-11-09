import { validateHeaderValue } from 'node:http';
import { extname } from 'node:path';
import { directFileExtensions } from '../lib/format-options.js';
import { md5, normalizeDownloadUrl } from '../lib/utils.js';
import type { TaskOptions } from '../types/contract.js';

const supportedHeaders = new Set(['referer', 'origin', 'cookie', 'user-agent', 'authorization']);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const string = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function catCatchTasks(payload: unknown): (TaskOptions & { url: string })[] {
  const body = object(payload);
  if (body?.action !== 'catch') throw new Error('仅支持猫抓资源发送（action: catch）');
  const resources = Array.isArray(body.data) ? body.data : [body.data];
  if (!resources.length || resources.length > 100) throw new Error('每次请发送 1–100 条猫抓资源');
  return resources.map(resource => {
    const data = object(resource);
    if (!data || typeof data.url !== 'string') throw new Error('猫抓资源缺少下载链接');
    const url = normalizeDownloadUrl(data.url);
    const headers: Record<string, string> = {};
    const addHeader = (name: string, value: unknown) => {
      const key = name.trim().toLowerCase();
      if (!supportedHeaders.has(key) || typeof value !== 'string' || !value.trim()) return;
      try {
        validateHeaderValue(key, value);
      } catch {
        throw new Error(`猫抓请求头无效: ${key}`);
      }
      headers[key] = value;
    };
    // Newer templates flatten these fields; older versions also send requestHeaders.
    for (const key of supportedHeaders) addHeader(key, data[key]);
    addHeader('user-agent', data.userAgent);
    if (Array.isArray(data.requestHeaders)) {
      for (const item of data.requestHeaders) {
        const entry = object(item);
        if (typeof entry?.name === 'string') addHeader(entry.name, entry.value);
      }
    } else {
      for (const [name, value] of Object.entries(object(data.requestHeaders) || {})) addHeader(name, value);
    }

    const mime = string(data.type).toLowerCase().split(';')[0].trim();
    const mimeExt =
      mime === 'text/vtt' ? '.vtt' : ['application/x-subrip', 'text/srt'].includes(mime) ? '.srt' : `.${mime.split('/')[1] || ''}`;
    const hint = `.${string(data.ext).toLowerCase().replace(/^\./, '')}`;
    const pathname = new URL(url).pathname;
    const urlExt = extname(pathname).toLowerCase();
    const name = string(data.name) || string(data.fullFileName);
    const nameExt = extname(name).toLowerCase();
    const hints = [hint, urlExt, nameExt];
    if (hints.includes('.mpd') || mime === 'application/dash+xml') throw new Error('当前下载器不支持 DASH/MPD');
    const hls = /mpegurl/.test(mime) || hints.some(ext => ext === '.m3u8' || ext === '.m3u');
    const fileExt = [mimeExt, ...hints].map(ext => (ext === '.x-subrip' ? '.srt' : ext)).find(ext => directFileExtensions.includes(ext));
    const base = (name || string(data.title) || pathname.split('/').pop() || md5(url)).split(/[\\/]/).pop().slice(0, 120);
    const filename =
      hls && base
        ? `${base.replace(/\.(m3u8?|txt|mp4)$/i, '')}.mp4`
        : fileExt && base && !base.toLowerCase().endsWith(fileExt)
          ? `${base}${fileExt}`
          : base || undefined;
    return { url, filename, type: !hls && fileExt ? 'file' : 'm3u8', headers, useDefaultHeaders: false };
  });
}

import type { OutgoingHttpHeaders } from 'node:http';
import type { ExtractedMedia, ExtractionResult } from '../types/contract.js';
import { VideoParser } from '../video-parser/index.js';
import { sourceUrl } from '../video-parser/platform.js';
import { requestPage } from '../video-parser/request.js';
import { formatHeaders, headersForTarget, normalizeDownloadUrl } from './utils.js';

export interface GetM3u8UrlsOption {
  url: string;
  urls?: string[];
  headers?: OutgoingHttpHeaders | string;
  deep?: number;
  maxPages?: number;
  maxUrls?: number;
  maxHtmlSize?: number;
  concurrency?: number;
  pathFilter?: string;
  subUrlRegex?: string | RegExp;
  signal?: AbortSignal;
  visited?: Set<string>;
}
export function decodePageText(input: string) {
  return input
    .replace(/\\u00(2f|3a|26|3d)/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\x(2f|3a|26|3d)/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\\//g, '/')
    .replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[\da-f]+|\d+);/gi, entity => {
      const names: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
      if (names[entity.toLowerCase()]) return names[entity.toLowerCase()];
      const value = entity.slice(2, -1);
      const code = /^x/i.test(value) ? Number.parseInt(value.slice(1), 16) : Number(value);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
}
const mediaExtension = /\.(m3u8|mp4|mkv|mov|m4v|webm|mp3|m4a|aac|vtt|srt|ass|ssa)$/i;
function mediaType(url: string) {
  const ext = mediaExtension.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return ext ? (ext === 'm3u8' ? 'm3u8' : 'file') : undefined;
}
function link(value: string, base: string) {
  try {
    let decoded = decodePageText(value).trim();
    if (/^https?%3a/i.test(decoded)) decoded = decodeURIComponent(decoded);
    const url = new URL(decoded, base);
    url.hash = '';
    return normalizeDownloadUrl(url.href);
  } catch {
    return '';
  }
}
function textTitle(html: string) {
  return decodePageText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 150);
}

/** Bounded breadth-first crawl. HTML and embedded JSON are read as data, never executed. */
export async function extractMedia(options: GetM3u8UrlsOption): Promise<ExtractionResult> {
  const seeds = options.urls || [options.url];
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 20) throw new Error('每次可提取 1–20 个网页或分享链接');
  const depth = Math.min(3, Math.max(0, Math.floor(Number(options.deep ?? 1)) || 0));
  const maxPages = Math.min(60, Math.max(1, Math.floor(Number(options.maxPages) || 30)));
  const maxUrls = Math.min(500, Math.max(1, Math.floor(Number(options.maxUrls) || 100)));
  const parallel = Math.min(4, Math.max(1, Math.floor(Number(options.concurrency) || 3)));
  // Budget per request, not per crawl: parsing a large page synchronously must not spend it.
  const pageBudgetMs = 60_000;
  const headers = formatHeaders(options.headers);
  const visited = options.visited || new Set<string>();
  const found = new Map<string, ExtractedMedia>();
  const result: ExtractionResult = { items: [], errors: [], pagesVisited: 0, truncated: false };
  const queue: { url: string; depth: number; root: string; title?: string }[] = [];
  const enqueue = (url: string, level: number, root: string, title?: string) => {
    if (!url || visited.has(url)) return;
    if (visited.size >= maxPages) {
      result.truncated = true;
      return;
    }
    visited.add(url);
    queue.push({ url, depth: level, root, title });
  };
  for (const seed of seeds) {
    const url = sourceUrl(seed);
    enqueue(url, 0, url);
  }
  const add = (url: string, source: string, title: string, type?: 'file' | 'm3u8', platform?: string, credentialSource = source) => {
    if (!url || found.has(url)) return;
    if (found.size >= maxUrls) {
      result.truncated = true;
      return;
    }
    found.set(url, { url, source, credentialSource, title, type: type || mediaType(url) || 'file', ...(platform ? { platform } : {}) });
  };
  const crawl = async (entry: (typeof queue)[number]) => {
    options.signal?.throwIfAborted();
    result.pagesVisited++;
    // Each request gets its own budget: the synchronous parsing pass must not consume it.
    const pageSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(pageBudgetMs)])
      : AbortSignal.timeout(pageBudgetMs);
    try {
      const outgoing = headersForTarget(entry.root, entry.url, headers);
      if (VideoParser.getPlatform(entry.url).platform !== 'unknown') {
        const parsed = await VideoParser.parse(entry.url, outgoing, { signal: pageSignal });
        if (parsed.code || !parsed.data?.url) throw new Error(parsed.message || '平台未返回媒体链接');
        add(parsed.data.url, entry.url, parsed.data.title || entry.title || '', undefined, parsed.data.platform, entry.root);
        return;
      }
      const direct = mediaType(entry.url);
      if (direct) {
        add(entry.url, entry.root, entry.title || '', direct);
        return;
      }
      const page = await requestPage(entry.url, {
        headers: outgoing,
        signal: pageSignal,
        maxBytes: Math.min(options.maxHtmlSize || 5 * 1024 * 1024, 5 * 1024 * 1024),
      });
      if (
        /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(page.contentType) ||
        page.text.trimStart().startsWith('#EXTM3U')
      ) {
        add(page.url, entry.root, entry.title || '', 'm3u8', undefined, entry.root);
        return;
      }
      const html = decodePageText(page.text);
      const title = textTitle(html) || entry.title || '';
      const baseAttribute = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
      const base = baseAttribute ? link(baseAttribute, page.url) || page.url : page.url;
      for (const match of html.matchAll(/https?:\/\/[^\s<>"'`\\]+/gi)) {
        const url = link(match[0], base);
        if (url && mediaType(url)) add(url, page.url, title, undefined, undefined, entry.root);
      }
      for (const match of html.matchAll(/["']([^"'<>\r\n]{1,4096})["']/g)) {
        const url = link(match[1], base);
        if (url && mediaType(url)) add(url, page.url, title, undefined, undefined, entry.root);
      }
      for (const match of html.matchAll(/<(video|source|track|iframe|a)\b([^>]*)>/gi)) {
        const tag = match[1].toLowerCase();
        const attributes = Object.fromEntries(
          [...match[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(value => [
            value[1].toLowerCase(),
            value[2] ?? value[3] ?? value[4],
          ])
        );
        const url = link(attributes.src || attributes['data-src'] || attributes.href || '', base);
        if (!url || !(attributes.src || attributes['data-src'] || attributes.href)) continue;
        if (mediaType(url)) {
          add(url, page.url, title, undefined, undefined, entry.root);
          continue;
        }
        if (['video', 'source', 'track'].includes(tag)) {
          add(url, page.url, title, /mpegurl|hls/i.test(attributes.type || '') ? 'm3u8' : 'file', undefined, entry.root);
          continue;
        }
        if (entry.depth >= depth) continue;
        if (tag === 'a' && new URL(url).origin !== new URL(page.url).origin) continue;
        if (tag === 'a' && options.pathFilter && !url.includes(options.pathFilter)) continue;
        if (tag === 'a' && options.subUrlRegex) {
          const rule = options.subUrlRegex;
          if (rule instanceof RegExp) {
            rule.lastIndex = 0;
            if (!rule.test(url)) continue;
          } else if (!url.includes(rule.replace(/\*/g, ''))) continue;
        }
        enqueue(url, entry.depth + 1, entry.root, title);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      result.errors.push({
        url: entry.url,
        message: pageSignal.aborted && !options.signal?.aborted ? '单个页面请求超时' : (error as Error).message,
      });
    }
  };
  while (queue.length && found.size < maxUrls) {
    options.signal?.throwIfAborted();
    await Promise.all(queue.splice(0, parallel).map(crawl));
  }
  if (queue.length) result.truncated = true;
  result.items = [...found.values()];
  return result;
}
/** Legacy SDK entry point: URL -> title mapping. */
export async function getM3u8Urls(options: GetM3u8UrlsOption) {
  const result = await extractMedia(options);
  if (!result.items.length && result.errors.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return new Map(result.items.map(item => [item.url, item.title]));
}

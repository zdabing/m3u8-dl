import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { RssBridgeFeed, ServerConfig } from '../types/contract.js';

const DEFAULT_FEED_URL = 'https://tangxinvlog.app/rss.xml';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_DETAILS_CACHE = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const SEGMENT_TIMEOUT_MS = 60_000;
const FETCH_CONCURRENCY = 4;
const PROXY_SAFE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const STATIC_ASSET_RX = /\.(?:css|js|mjs|cjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map|json|xml)$/i;

interface CachedDetail {
  m3u8Url: string;
  title?: string;
  cover?: string;
  referer?: string;
  fetchedAt: number;
}

interface ParsedRssItem {
  guid: string;
  title: string;
  pageUrl: string;
  pubDate: string;
  description: string;
}

interface ResolvedRssItem extends ParsedRssItem {
  m3u8Url: string;
  cover: string;
}

interface RssChannel {
  title: string;
  link: string;
  description: string;
}

interface EffectiveFeed {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'rss' | 'html';
  url: string;
  itemPattern: string;
  referer: string;
  limit: number;
  cacheTtl: number;
}

interface FeedSnapshot {
  channel: RssChannel;
  items: ResolvedRssItem[];
  failedCount: number;
  requestedLimit: number;
  fetchedAt: number;
  feedUrl: string;
  mode: 'rss' | 'html';
  itemPattern: string;
  referer: string;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

export function defaultRssBridgeFeeds(cfg: ServerConfig): RssBridgeFeed[] {
  if (Array.isArray(cfg.rssBridgeFeeds)) {
    return cfg.rssBridgeFeeds.map(feed => ({
      id: String(feed.id || '').trim() || 'default',
      name: String(feed.name || '').trim() || String(feed.id || '默认订阅源'),
      enabled: feed.enabled !== false,
      mode: feed.mode === 'html' ? 'html' : 'rss',
      url: String(feed.url || '').trim(),
      itemPattern: String(feed.itemPattern || '').trim(),
      referer: String(feed.referer || '').trim(),
      limit: clampInt(feed.limit, 20, 1, 50),
      cacheTtl: clampInt(feed.cacheTtl, 300, 0, 86400),
    }));
  }

  return [
    {
      id: 'default',
      name: '默认订阅源',
      enabled: true,
      mode: 'rss',
      url: String(cfg.rssBridgeFeedUrl || '').trim() || DEFAULT_FEED_URL,
      itemPattern: '',
      referer: String(cfg.rssBridgeReferer || '').trim(),
      limit: clampInt(cfg.rssBridgeLimit, 20, 1, 50),
      cacheTtl: clampInt(cfg.rssBridgeCacheTtl, 300, 0, 86400),
    },
  ];
}

function makeItemId(guid: string) {
  return createHash('sha256').update(String(guid)).digest('hex').slice(0, 16);
}

function makeSafeSlug(title: string, fallbackId: string) {
  let cleaned = '';
  for (const ch of String(title || '')) {
    const code = ch.charCodeAt(0);
    cleaned += code < 0x20 || '<>:"/\\|?*#%'.includes(ch) ? ' ' : ch;
  }
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/\.(?:m3u8?|mp4)$/i, '')
    .replace(/[. ]+$/, '');
  return cleaned || `video-${String(fallbackId || 'item').replace(/[^a-zA-Z0-9_-]/g, '') || 'stream'}`;
}

function decodeXmlEntities(text: string) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|#39);/g, (full, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return "'";
      default: {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          const code = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
        }
        if (entity.startsWith('#')) {
          const code = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
        }
        return full;
      }
    }
  });
}

function stripCdata(raw: string) {
  return String(raw || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

function extractTag(block: string, tag: string) {
  const rx = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = rx.exec(block);
  if (!match) return '';
  const inner = match[1];
  if (/<!\[CDATA\[/.test(inner)) return stripCdata(inner);
  return decodeXmlEntities(inner).trim();
}

function escapeXml(str: string) {
  let out = '';
  for (const ch of String(str ?? '')) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}

function matchesItemPattern(pageUrl: string, itemPattern: string) {
  const pattern = itemPattern.trim().toLowerCase();
  return !pattern || pageUrl.toLowerCase().includes(pattern);
}

function parseRssItems(xml: string, limit: number, feedUrl: string, itemPattern: string) {
  const firstItemIdx = xml.search(/<item\b/i);
  const channelHeader = firstItemIdx >= 0 ? xml.slice(0, firstItemIdx) : xml;
  const fallbackOrigin = new URL(feedUrl).origin;
  const channel: RssChannel = {
    title: extractTag(channelHeader, 'title') || new URL(feedUrl).hostname,
    link: extractTag(channelHeader, 'link') || fallbackOrigin,
    description: extractTag(channelHeader, 'description') || 'Trimmed HLS RSS Relay',
  };

  const items: ParsedRssItem[] = [];
  const itemRx = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRx.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const rawLink = extractTag(block, 'link');
    let pageUrl = '';
    if (rawLink) {
      try {
        const resolved = new URL(rawLink, feedUrl);
        if (['http:', 'https:'].includes(resolved.protocol)) pageUrl = resolved.href;
      } catch {
        pageUrl = '';
      }
    }
    const guid = extractTag(block, 'guid') || pageUrl || title;
    const pubDate = extractTag(block, 'pubDate');
    const description = extractTag(block, 'description');
    if (!guid || !pageUrl || !matchesItemPattern(pageUrl, itemPattern)) continue;
    items.push({ guid, title: title || guid, pageUrl, pubDate, description });
    if (items.length >= limit) break;
  }

  return { channel, items };
}

function parseHtmlListItems(html: string, limit: number, listUrl: string, itemPattern: string, feedName: string) {
  const listParsed = new URL(listUrl);
  listParsed.hash = '';
  const pageTitle = extractTag(html, 'title')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const channel: RssChannel = {
    title: feedName || pageTitle || listParsed.hostname,
    link: listUrl,
    description: `${feedName || listParsed.hostname} HTML 列表订阅`,
  };

  const items: ParsedRssItem[] = [];
  const seenUrls = new Set<string>();
  const linkRx = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const hrefRx = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
  const attrTitleRx = /\b(?:title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  const altRx = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  const pattern = itemPattern.trim();

  let match: RegExpExecArray | null;
  while ((match = linkRx.exec(html)) !== null) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const hrefMatch = hrefRx.exec(attrs);
    const rawHref = decodeXmlEntities((hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '').trim());
    if (!rawHref || rawHref.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(rawHref)) continue;

    let resolved: URL;
    try {
      resolved = new URL(rawHref, listUrl);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(resolved.protocol)) continue;
    resolved.hash = '';
    if (resolved.href === listParsed.href || STATIC_ASSET_RX.test(resolved.pathname)) continue;
    if (pattern) {
      if (!matchesItemPattern(resolved.href, pattern)) continue;
    } else if (resolved.origin !== listParsed.origin || resolved.pathname.length <= 1) {
      continue;
    }

    if (seenUrls.has(resolved.href)) continue;
    seenUrls.add(resolved.href);

    const innerText = decodeXmlEntities(inner.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    const attrMatch = attrTitleRx.exec(attrs) || altRx.exec(inner);
    const attrTitle = decodeXmlEntities((attrMatch?.[1] ?? attrMatch?.[2] ?? '').trim())
      .replace(/\s+/g, ' ')
      .trim();
    const pathTail = resolved.pathname.split('/').filter(Boolean).pop() || resolved.hostname;
    const title = (innerText || attrTitle || pathTail).slice(0, 160);

    items.push({ guid: resolved.href, title, pageUrl: resolved.href, pubDate: '', description: '' });
    if (items.length >= limit) break;
  }

  return { channel, items };
}

function cleanMatchedUrl(raw: string) {
  return decodeXmlEntities(String(raw || '').trim()).replace(/\\+$/, '');
}

function extractM3u8FromHtml(html: string, pageUrl: string) {
  const candidates = [html, html.replace(/\\\//g, '/')];
  const absRx = /https?:\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/i;
  for (const text of candidates) {
    const match = absRx.exec(text);
    if (match) {
      try {
        const u = new URL(cleanMatchedUrl(match[0]));
        if (['http:', 'https:'].includes(u.protocol)) return u.href;
      } catch {
        /* Try next candidate. */
      }
    }
  }

  const relRx = /(?:src|url|file)\s*[:=]\s*['"]([^'"]+?\.m3u8(?:\?[^'"]*)?)['"]/i;
  for (const text of candidates) {
    const match = relRx.exec(text);
    if (match) {
      try {
        const u = new URL(cleanMatchedUrl(match[1]), pageUrl);
        if (['http:', 'https:'].includes(u.protocol)) return u.href;
      } catch {
        /* Ignore invalid URL. */
      }
    }
  }

  return '';
}

function extractCoverFromHtml(html: string, pageUrl: string) {
  const ogMatch =
    /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i.exec(html);
  const raw = ogMatch?.[1] || /https?:\/\/[^\s"'<>\\]+?\/cover\.jpg(?:\?[^\s"'<>\\]*)?/i.exec(html)?.[0];
  if (!raw) return '';
  try {
    const u = new URL(cleanMatchedUrl(raw), pageUrl);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

function buildProxyM3u8Url(publicBase: string, item: Pick<ResolvedRssItem, 'guid' | 'title'>, tokenQuery: string) {
  const id = makeItemId(item.guid);
  const slug = makeSafeSlug(item.title, id);
  return `${publicBase}/rss-bridge/hls/${id}/${encodeURIComponent(slug)}.m3u8${tokenQuery}`;
}

function rewriteM3u8Playlist(
  playlistText: string,
  upstreamUrl: string,
  id: string,
  publicBase: string,
  allowRelative: boolean,
  tokenQuery: string
) {
  const upstreamDir = new URL('./', upstreamUrl).href;

  const rewriteUri = (rawUri: string) => {
    const trimmed = String(rawUri || '').trim();
    if (!trimmed) return trimmed;
    let abs: URL;
    try {
      abs = new URL(trimmed, upstreamUrl);
    } catch {
      return trimmed;
    }
    if (!['http:', 'https:'].includes(abs.protocol)) return trimmed;
    if (
      allowRelative &&
      abs.href.startsWith(upstreamDir) &&
      !trimmed.includes('..') &&
      !abs.search &&
      !abs.pathname.toLowerCase().endsWith('.m3u8')
    ) {
      return `${abs.href.slice(upstreamDir.length)}${tokenQuery}`;
    }
    const extraToken = tokenQuery ? `&${tokenQuery.slice(1)}` : '';
    return `${publicBase}/rss-bridge/hls-sub/${id}?u=${encodeURIComponent(abs.href)}${extraToken}`;
  };

  return String(playlistText || '')
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (/^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF):/i.test(trimmed)) {
        return trimmed.replace(/URI="([^"]+)"/gi, (_full, uri: string) => `URI="${rewriteUri(uri)}"`);
      }
      if (trimmed.startsWith('#')) return line;
      return rewriteUri(trimmed);
    })
    .join('\n');
}

function renderRssXml(
  channel: RssChannel,
  items: ResolvedRssItem[],
  options: { linkMedia: boolean; direct: boolean; publicBase: string; tokenQuery: string }
) {
  const ready = items.filter(item => item.m3u8Url);
  const itemXml = ready
    .map(item => {
      const enclosureUrl = options.direct ? item.m3u8Url : buildProxyM3u8Url(options.publicBase, item, options.tokenQuery);
      const linkUrl = options.linkMedia ? enclosureUrl : item.pageUrl;
      const lines = [
        '    <item>',
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(linkUrl)}</link>`,
        `      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
      ];
      if (item.pubDate) {
        lines.push(`      <pubDate>${escapeXml(item.pubDate)}</pubDate>`);
      }
      lines.push(`      <enclosure url="${escapeXml(enclosureUrl)}" type="application/vnd.apple.mpegurl" length="0" />`);
      lines.push(`      <description>${escapeXml(`Source: ${item.pageUrl}`)}</description>`);
      lines.push('    </item>');
      return lines.join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.link)}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    '    <generator>m3u8-dl rss-bridge</generator>',
    itemXml,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function sendJson(res: Response, status: number, data: unknown) {
  res.status(status).set('Cache-Control', 'no-store').json(data);
}

function resolvePublicBase(req: Request) {
  const rawProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : req.protocol === 'https' ? 'https' : 'http';
  const rawHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const host = rawHost || req.headers.host || '127.0.0.1:6600';
  return `${proto}://${host}`;
}

export class RssBridgeService {
  private cacheFile: string;
  private details: Record<string, CachedDetail> = {};
  private detailsById = new Map<string, CachedDetail & { guid: string }>();
  private activeControllers = new Set<AbortController>();
  private writeQueue = Promise.resolve();
  private cachedFeeds = new Map<string, FeedSnapshot>();
  private inflightRefreshes = new Map<string, Promise<FeedSnapshot>>();
  private cacheGeneration = 0;
  private closed = false;

  constructor(
    cacheDir: string,
    private getConfig: () => ServerConfig
  ) {
    this.cacheFile = resolve(cacheDir, 'rss-bridge-cache.json');
  }

  async init() {
    try {
      const raw = await readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(raw) as { details?: Record<string, CachedDetail> };
      if (parsed?.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)) {
        this.details = parsed.details;
        for (const [guid, detail] of Object.entries(this.details)) {
          if (detail?.m3u8Url) {
            this.detailsById.set(makeItemId(guid), { guid, ...detail });
          }
        }
      }
    } catch {
      /* Cache file may not exist on first launch. */
    }
  }

  invalidateCache() {
    this.cacheGeneration++;
    this.cachedFeeds.clear();
    this.inflightRefreshes.clear();
  }

  close() {
    this.closed = true;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  private resolveFeedList(): EffectiveFeed[] {
    const rawFeeds = defaultRssBridgeFeeds(this.getConfig());
    const out: EffectiveFeed[] = [];
    for (const feed of rawFeeds) {
      let url = DEFAULT_FEED_URL;
      if (feed.url) {
        try {
          const parsed = new URL(feed.url);
          if (!['http:', 'https:'].includes(parsed.protocol)) continue;
          url = parsed.href;
        } catch {
          continue;
        }
      }
      let referer = `${new URL(url).origin}/`;
      if (feed.referer?.trim()) {
        try {
          const parsedRef = new URL(feed.referer.trim());
          if (['http:', 'https:'].includes(parsedRef.protocol)) referer = parsedRef.href;
        } catch {
          /* Keep origin fallback. */
        }
      }
      out.push({
        id: feed.id,
        name: feed.name || feed.id,
        enabled: feed.enabled,
        mode: feed.mode === 'html' ? 'html' : 'rss',
        url,
        itemPattern: String(feed.itemPattern || '').trim(),
        referer,
        limit: clampInt(feed.limit, 20, 1, 50),
        cacheTtl: clampInt(feed.cacheTtl, 300, 0, 86400),
      });
    }
    return out;
  }

  private saveCache() {
    const entries = Object.entries(this.details);
    if (entries.length > MAX_DETAILS_CACHE) {
      entries.sort((a, b) => (b[1]?.fetchedAt || 0) - (a[1]?.fetchedAt || 0));
      this.details = Object.fromEntries(entries.slice(0, MAX_DETAILS_CACHE));
    }
    const content = `${JSON.stringify({ details: this.details }, null, 2)}\n`;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        const tmp = `${this.cacheFile}.tmp`;
        await writeFile(tmp, content, 'utf8');
        await rename(tmp, this.cacheFile);
      });
    return this.writeQueue;
  }

  private async fetchText(url: string, headers: Record<string, string>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed) throw new Error('服务正在关闭');
      const controller = new AbortController();
      this.activeControllers.add(controller);
      try {
        const res = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} ${res.statusText}`) as Error & { retryable?: boolean };
          err.retryable = res.status >= 500 || res.status === 429;
          throw err;
        }
        return await res.text();
      } catch (err) {
        lastError = err;
        const retryable = (err as { retryable?: boolean })?.retryable !== false;
        if (attempt > 0 || !retryable || this.closed) break;
        await new Promise(done => setTimeout(done, 300));
      } finally {
        this.activeControllers.delete(controller);
      }
    }
    throw lastError;
  }

  private async resolveItems(rawItems: ParsedRssItem[], referer: string) {
    let updated = 0;
    let failedCount = 0;

    const resolved = await mapPool(rawItems, FETCH_CONCURRENCY, async item => {
      const cached = this.details[item.guid];
      if (cached?.m3u8Url) {
        const synced: CachedDetail = cached.referer === referer ? cached : { ...cached, referer };
        if (cached.referer !== referer) {
          this.details[item.guid] = synced;
          updated++;
        }
        this.detailsById.set(makeItemId(item.guid), { guid: item.guid, ...synced });
        return { ...item, m3u8Url: synced.m3u8Url, cover: synced.cover || '' };
      }

      if (/\.m3u8(?:\?|$)/i.test(item.pageUrl)) {
        const detail: CachedDetail = { m3u8Url: item.pageUrl, title: item.title, cover: '', referer, fetchedAt: Date.now() };
        this.details[item.guid] = detail;
        this.detailsById.set(makeItemId(item.guid), { guid: item.guid, ...detail });
        updated++;
        return { ...item, m3u8Url: item.pageUrl, cover: '' };
      }

      try {
        const html = await this.fetchText(item.pageUrl, {
          'user-agent': DEFAULT_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer,
        });
        const m3u8Url = extractM3u8FromHtml(html, item.pageUrl);
        if (!m3u8Url) {
          failedCount++;
          return { ...item, m3u8Url: '', cover: '' };
        }
        const cover = extractCoverFromHtml(html, item.pageUrl);
        const detail: CachedDetail = { m3u8Url, title: item.title, cover, referer, fetchedAt: Date.now() };
        this.details[item.guid] = detail;
        this.detailsById.set(makeItemId(item.guid), { guid: item.guid, ...detail });
        updated++;
        return { ...item, m3u8Url, cover };
      } catch {
        failedCount++;
        return { ...item, m3u8Url: '', cover: '' };
      }
    });

    if (updated > 0) await this.saveCache();
    return { resolved, failedCount };
  }

  private async getOrRefreshFeed(feed: EffectiveFeed, targetLimit: number, forceRefresh: boolean) {
    const effectiveLimit = Math.max(feed.limit, targetLimit);
    const now = Date.now();
    const cached = this.cachedFeeds.get(feed.id);
    const isFresh =
      cached &&
      now - cached.fetchedAt < feed.cacheTtl * 1000 &&
      cached.requestedLimit >= targetLimit &&
      cached.feedUrl === feed.url &&
      cached.mode === feed.mode &&
      cached.itemPattern === feed.itemPattern &&
      cached.referer === feed.referer;

    if (!forceRefresh && isFresh) return cached;
    const inflight = this.inflightRefreshes.get(feed.id);
    if (inflight) return inflight;

    const generation = this.cacheGeneration;
    const promise = (async (): Promise<FeedSnapshot> => {
      const body = await this.fetchText(
        feed.url,
        feed.mode === 'html'
          ? {
              'user-agent': DEFAULT_UA,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              referer: feed.referer,
            }
          : {
              'user-agent': DEFAULT_UA,
              accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
            }
      );
      const parsed =
        feed.mode === 'html'
          ? parseHtmlListItems(body, effectiveLimit, feed.url, feed.itemPattern, feed.name)
          : parseRssItems(body, effectiveLimit, feed.url, feed.itemPattern);
      const { resolved, failedCount } = await this.resolveItems(parsed.items, feed.referer);
      const snapshot: FeedSnapshot = {
        channel: parsed.channel,
        items: resolved,
        failedCount,
        requestedLimit: effectiveLimit,
        fetchedAt: Date.now(),
        feedUrl: feed.url,
        mode: feed.mode,
        itemPattern: feed.itemPattern,
        referer: feed.referer,
      };
      if (generation === this.cacheGeneration) {
        this.cachedFeeds.set(feed.id, snapshot);
      }
      return snapshot;
    })();

    this.inflightRefreshes.set(feed.id, promise);
    try {
      return await promise;
    } finally {
      if (this.inflightRefreshes.get(feed.id) === promise) {
        this.inflightRefreshes.delete(feed.id);
      }
    }
  }

  private upstreamHeaders(referer: string, req?: Request) {
    const headers: Record<string, string> = {
      'user-agent': DEFAULT_UA,
      referer,
      origin: new URL(referer).origin,
    };
    if (req?.headers.range) {
      headers.range = String(req.headers.range);
    }
    return headers;
  }

  private async proxyHlsTarget(options: {
    req: Request;
    res: Response;
    targetUrl: string;
    referer: string;
    isPlaylist: boolean;
    allowRelative: boolean;
    id: string;
    publicBase: string;
    tokenQuery: string;
  }) {
    const { req, res, targetUrl, referer, isPlaylist, allowRelative, id, publicBase, tokenQuery } = options;

    if (isPlaylist) {
      const text = await this.fetchText(targetUrl, this.upstreamHeaders(referer));
      const rewritten = rewriteM3u8Playlist(text, targetUrl, id, publicBase, allowRelative, tokenQuery);
      res
        .status(200)
        .set({
          'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'content-length': String(Buffer.byteLength(rewritten, 'utf8')),
          'cache-control': 'no-store',
        })
        .end(req.method === 'HEAD' ? '' : rewritten);
      return;
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('Upstream segment timeout')), SEGMENT_TIMEOUT_MS);
    const onClientClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once('close', onClientClose);

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: this.upstreamHeaders(referer, req),
        redirect: 'follow',
        signal: controller.signal,
      });
      const outHeaders: Record<string, string> = { 'cache-control': 'no-store' };
      for (const key of PROXY_SAFE_HEADERS) {
        const value = upstreamRes.headers.get(key);
        if (value !== null) outHeaders[key] = value;
      }
      res.writeHead(upstreamRes.status, outHeaders);
      if (req.method === 'HEAD' || !upstreamRes.body) {
        res.end();
        return;
      }
      const stream = Readable.fromWeb(upstreamRes.body as unknown as import('node:stream/web').ReadableStream);
      await pipeline(stream, res);
    } catch (err) {
      if (controller.signal.aborted && res.headersSent) return;
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: (err as Error)?.message || '上游媒体代理失败' });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    } finally {
      clearTimeout(timer);
      res.removeListener('close', onClientClose);
      this.activeControllers.delete(controller);
    }
  }

  private async serveFeedResponse(
    req: Request,
    res: Response,
    feed: EffectiveFeed,
    format: 'xml' | 'json',
    publicBase: string,
    tokenQuery: string
  ) {
    try {
      const reqLimit = clampInt(req.query.limit, feed.limit, 1, 50);
      const forceRefresh = req.query.refresh === '1';
      const linkMedia = req.query.link === 'media';
      const direct = req.query.direct === '1';
      const data = await this.getOrRefreshFeed(feed, reqLimit, forceRefresh);
      const items = data.items.slice(0, reqLimit);

      if (format === 'json') {
        sendJson(res, 200, {
          ok: true,
          feed: { id: feed.id, name: feed.name, mode: feed.mode },
          channel: data.channel,
          fetchedAt: new Date(data.fetchedAt).toISOString(),
          count: items.filter(it => it.m3u8Url).length,
          failedCount: data.failedCount,
          items: items.map(it => ({
            guid: it.guid,
            title: it.title,
            pageUrl: it.pageUrl,
            m3u8Url: it.m3u8Url,
            proxyM3u8Url: it.m3u8Url ? buildProxyM3u8Url(publicBase, it, tokenQuery) : '',
            cover: it.cover,
            pubDate: it.pubDate,
            referer: feed.referer,
          })),
        });
        return;
      }

      const xml = renderRssXml(data.channel, items, { linkMedia, direct, publicBase, tokenQuery });
      res
        .status(200)
        .set({
          'content-type': 'application/rss+xml; charset=utf-8',
          'cache-control': `public, max-age=${feed.cacheTtl}`,
        })
        .end(req.method === 'HEAD' ? '' : xml);
    } catch (err) {
      sendJson(res, 502, { ok: false, error: (err as Error)?.message || '上游拉取失败' });
    }
  }

  async handle(req: Request, res: Response, tokenForLinks = '') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    const rawPathname = String(req.originalUrl || req.url || '/').split('?')[0];
    const hlsPrefixMatch = /^\/rss-bridge\/hls\/[0-9a-f]{16}\/(.*)$/i.exec(rawPathname);
    if (hlsPrefixMatch) {
      const rawTail = hlsPrefixMatch[1];
      let decodedTail = rawTail;
      try {
        decodedTail = decodeURIComponent(rawTail);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid path encoding' });
        return;
      }
      if (
        !decodedTail ||
        decodedTail.startsWith('/') ||
        rawTail.includes('\\') ||
        decodedTail.includes('\\') ||
        rawTail.split('/').some(seg => seg === '..' || /^%2e%2e$/i.test(seg)) ||
        decodedTail.split('/').some(seg => seg === '..')
      ) {
        sendJson(res, 400, { ok: false, error: 'Invalid path' });
        return;
      }
    }

    const path = req.path || '/';
    const feeds = this.resolveFeedList();
    const publicBase = resolvePublicBase(req);
    const tokenQuery = tokenForLinks ? `?token=${encodeURIComponent(tokenForLinks)}` : '';

    if (path === '/health') {
      sendJson(res, 200, {
        ok: true,
        enabled: true,
        feeds: feeds.map(feed => {
          const snapshot = this.cachedFeeds.get(feed.id);
          return {
            id: feed.id,
            name: feed.name,
            enabled: feed.enabled,
            mode: feed.mode,
            url: feed.url,
            lastRefreshAt: snapshot?.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : null,
          };
        }),
        cachedDetails: Object.keys(this.details).length,
        indexedStreams: this.detailsById.size,
      });
      return;
    }

    const hlsMatch = /^\/hls\/([0-9a-f]{16})\/(.+)$/i.exec(path);
    if (hlsMatch) {
      const id = hlsMatch[1].toLowerCase();
      const entry = this.detailsById.get(id);
      if (!entry?.m3u8Url) {
        sendJson(res, 404, { ok: false, error: 'Stream not found' });
        return;
      }
      const relPath = hlsMatch[2];
      if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.split('/').some(seg => seg === '..')) {
        sendJson(res, 400, { ok: false, error: 'Invalid path' });
        return;
      }
      const isPlaylist = relPath.toLowerCase().endsWith('.m3u8');
      let targetUrl = entry.m3u8Url;
      if (!isPlaylist) {
        let resolvedTarget: URL;
        try {
          resolvedTarget = new URL(relPath, entry.m3u8Url);
        } catch {
          sendJson(res, 400, { ok: false, error: 'Invalid asset path' });
          return;
        }
        if (resolvedTarget.origin !== new URL(entry.m3u8Url).origin) {
          sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
          return;
        }
        targetUrl = resolvedTarget.href;
      }
      const upstreamReferer = entry.referer || `${new URL(entry.m3u8Url).origin}/`;
      try {
        await this.proxyHlsTarget({
          req,
          res,
          targetUrl,
          referer: upstreamReferer,
          isPlaylist,
          allowRelative: true,
          id,
          publicBase,
          tokenQuery,
        });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: (err as Error)?.message || '上游代理失败' });
      }
      return;
    }

    const subMatch = /^\/hls-sub\/([0-9a-f]{16})$/i.exec(path);
    if (subMatch) {
      const id = subMatch[1].toLowerCase();
      const entry = this.detailsById.get(id);
      if (!entry?.m3u8Url) {
        sendJson(res, 404, { ok: false, error: 'Stream not found' });
        return;
      }
      const rawTarget = typeof req.query.u === 'string' ? req.query.u : '';
      let target: URL;
      try {
        target = new URL(rawTarget);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid target URL' });
        return;
      }
      if (!['http:', 'https:'].includes(target.protocol) || target.origin !== new URL(entry.m3u8Url).origin) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }
      const isPlaylist = target.pathname.toLowerCase().endsWith('.m3u8');
      const upstreamReferer = entry.referer || `${new URL(entry.m3u8Url).origin}/`;
      try {
        await this.proxyHlsTarget({
          req,
          res,
          targetUrl: target.href,
          referer: upstreamReferer,
          isPlaylist,
          allowRelative: false,
          id,
          publicBase,
          tokenQuery,
        });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: (err as Error)?.message || '上游代理失败' });
      }
      return;
    }

    const feedXmlMatch = /^\/feeds\/([a-zA-Z0-9_-]{1,40})(?:\.xml|\/rss\.xml)$/i.exec(path);
    const feedJsonMatch = /^\/feeds\/([a-zA-Z0-9_-]{1,40})(?:\.json|\/items\.json)$/i.exec(path);
    if (feedXmlMatch || feedJsonMatch) {
      const requestedId = (feedXmlMatch?.[1] || feedJsonMatch?.[1] || '').toLowerCase();
      const feed = feeds.find(item => item.id.toLowerCase() === requestedId);
      if (!feed?.enabled) {
        sendJson(res, 404, { ok: false, error: '订阅源不存在或未启用' });
        return;
      }
      await this.serveFeedResponse(req, res, feed, feedJsonMatch ? 'json' : 'xml', publicBase, tokenQuery);
      return;
    }

    if (path === '/items.json' || path === '/rss.xml' || path === '/') {
      const feed = feeds.find(item => item.id.toLowerCase() === 'default' && item.enabled) || feeds.find(item => item.enabled);
      if (!feed) {
        sendJson(res, 404, { ok: false, error: '没有启用的 RSS 订阅源' });
        return;
      }
      await this.serveFeedResponse(req, res, feed, path === '/items.json' ? 'json' : 'xml', publicBase, tokenQuery);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  }
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_FEED = 'https://tangxinvlog.app/rss.xml';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_DETAILS_CACHE = 500;
const PROXY_SAFE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

let writeQueue = Promise.resolve();

function makeItemId(guid) {
  return createHash('sha256').update(String(guid)).digest('hex').slice(0, 16);
}

function makeSafeSlug(title, fallbackId) {
  const cleaned = String(title || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*#%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/\.(?:m3u8?|mp4)$/i, '')
    .replace(/[. ]+$/, '');
  return cleaned || `video-${String(fallbackId || 'item').replace(/[^a-zA-Z0-9_-]/g, '') || 'stream'}`;
}

function buildProxyM3u8Url(publicBase, item) {
  const id = makeItemId(item.guid);
  const slug = makeSafeSlug(item.title, id);
  return `${publicBase}/hls/${id}/${encodeURIComponent(slug)}.m3u8`;
}

function clampInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function validateHttpUrl(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} 不是有效的 URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} 仅支持 http/https 协议: ${raw}`);
  }
  return parsed.href;
}

function printHelp() {
  console.log(`用法: node examples/rss-bridge.mjs [选项]

模式:
  --serve               启动本地精简 RSS 中转服务 (未指定 --once/--watch 时默认)
  --once                执行一次检查/推送后退出
  --watch               按指定间隔定时检查并推送 (可与 --serve 同时启用)
  --init-only           仅将当前最新 N 条标记为已处理，不抓取详情也不推送
  --dry-run             解析未推送条目的 m3u8 并打印结果，不实际推送也不写 seen 记录

通用选项:
  --feed <url>          上游 RSS 地址 (默认: ${DEFAULT_FEED}, 环境变量: RSS_FEED_URL)
  --limit <n>           保留最新条目数 1..50 (默认: 20, 环境变量: RSS_LIMIT)
  --concurrency <n>     详情页提取并发 1..8 (默认: 4, 环境变量: RSS_CONCURRENCY)
  --timeout <ms>        单次请求超时毫秒 (默认: 15000, 环境变量: RSS_TIMEOUT_MS)
  --referer <url>       详情抓取与推送附带的 Referer (默认: 上游站根域名, 环境变量: RSS_REFERER)
  --state-file <path>   状态与详情缓存文件 (默认: cache/rss-bridge-state.json, 环境变量: RSS_STATE_FILE)

中转服务选项 (--serve):
  --host <ip>           监听地址 (默认: 127.0.0.1, 环境变量: RSS_HOST)
  --port <port>         监听端口 (默认: 8788, 环境变量: RSS_PORT)
  --cache-ttl <sec>     RSS 响应缓存秒数 (默认: 300, 环境变量: RSS_CACHE_TTL)
  --public-url <url>    对外访问基地址，用于生成代理 m3u8 链接 (默认: 从请求 Host 推导, 环境变量: RSS_PUBLIC_URL)
  --direct              不走内置 HLS Referer 代理，直接输出源站 m3u8 地址 (也可通过 ?direct=1 开启, 环境变量: RSS_DIRECT)
  --link-media          将 <link> 同样设为 .m3u8 地址 (也可通过 ?link=media 开启)

推送选项 (--once / --watch):
  --interval <minutes>  定时轮询间隔分钟数 >=1 (默认: 30, 环境变量: RSS_INTERVAL)
  --push-url <url>      下载器推送接口 (如 http://127.0.0.1:6600/api/download, 环境变量: PUSH_URL)
  --push-token <token>  下载器访问密码/Token (环境变量: PUSH_TOKEN)
  -h, --help            显示此帮助信息
`);
}

function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const flags = {
    serve: false,
    once: false,
    watch: false,
    initOnly: false,
    dryRun: false,
    direct: ['1', 'true', 'yes'].includes(String(env.RSS_DIRECT || '').toLowerCase()),
    linkMedia: ['1', 'true', 'yes'].includes(String(env.RSS_LINK_MEDIA || '').toLowerCase()),
    feedUrl: env.RSS_FEED_URL || DEFAULT_FEED,
    limit: env.RSS_LIMIT,
    concurrency: env.RSS_CONCURRENCY,
    timeout: env.RSS_TIMEOUT_MS,
    cacheTtl: env.RSS_CACHE_TTL,
    referer: env.RSS_REFERER || '',
    stateFile: env.RSS_STATE_FILE || '',
    host: env.RSS_HOST || '127.0.0.1',
    port: env.RSS_PORT,
    publicUrl: env.RSS_PUBLIC_URL || '',
    interval: env.RSS_INTERVAL,
    pushUrl: env.PUSH_URL || '',
    pushToken: env.PUSH_TOKEN || '',
    help: false,
  };

  const valueFlags = new Set([
    '--feed',
    '--limit',
    '--concurrency',
    '--timeout',
    '--cache-ttl',
    '--referer',
    '--state-file',
    '--host',
    '--port',
    '--public-url',
    '--interval',
    '--push-url',
    '--push-token',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg === '--serve') {
      flags.serve = true;
      continue;
    }
    if (arg === '--once') {
      flags.once = true;
      continue;
    }
    if (arg === '--watch') {
      flags.watch = true;
      continue;
    }
    if (arg === '--init-only') {
      flags.initOnly = true;
      continue;
    }
    if (arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (arg === '--direct') {
      flags.direct = true;
      continue;
    }
    if (arg === '--link-media') {
      flags.linkMedia = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const key = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
    if (!valueFlags.has(key)) {
      throw new Error(`未知参数: ${arg} (使用 --help 查看说明)`);
    }
    let val = eqIdx > 0 ? arg.slice(eqIdx + 1) : argv[++i];
    if (val === undefined || (eqIdx < 0 && val.startsWith('--'))) {
      throw new Error(`参数 ${key} 缺少取值`);
    }
    val = String(val);
    if (key === '--feed') flags.feedUrl = val;
    else if (key === '--limit') flags.limit = val;
    else if (key === '--concurrency') flags.concurrency = val;
    else if (key === '--timeout') flags.timeout = val;
    else if (key === '--cache-ttl') flags.cacheTtl = val;
    else if (key === '--referer') flags.referer = val;
    else if (key === '--state-file') flags.stateFile = val;
    else if (key === '--host') flags.host = val;
    else if (key === '--port') flags.port = val;
    else if (key === '--public-url') flags.publicUrl = val;
    else if (key === '--interval') flags.interval = val;
    else if (key === '--push-url') flags.pushUrl = val;
    else if (key === '--push-token') flags.pushToken = val;
  }

  const feedUrl = validateHttpUrl(flags.feedUrl, 'feed');
  const referer = validateHttpUrl(flags.referer || `${new URL(feedUrl).origin}/`, 'referer');
  const pushUrl = flags.pushUrl ? validateHttpUrl(flags.pushUrl, 'push-url') : '';
  const publicUrl = flags.publicUrl ? validateHttpUrl(flags.publicUrl, 'public-url').replace(/\/+$/, '') : '';

  const explicitRun = flags.serve || flags.once || flags.watch;
  const once = flags.once || (!explicitRun && (flags.initOnly || flags.dryRun));
  const serve = flags.serve || (!once && !flags.watch);

  return {
    help: flags.help,
    serve,
    once,
    watch: flags.watch,
    initOnly: flags.initOnly,
    dryRun: flags.dryRun,
    direct: flags.direct,
    linkMedia: flags.linkMedia,
    feedUrl,
    limit: clampInt(flags.limit, 20, 1, 50),
    concurrency: clampInt(flags.concurrency, 4, 1, 8),
    timeout: clampInt(flags.timeout, 15000, 2000, 120000),
    cacheTtl: clampInt(flags.cacheTtl, 300, 0, 86400),
    referer,
    stateFile: resolve(process.cwd(), flags.stateFile || 'cache/rss-bridge-state.json'),
    host: flags.host,
    port: clampInt(flags.port, 8788, 1, 65535),
    publicUrl,
    intervalMinutes: clampInt(flags.interval, 30, 1, 10080),
    pushUrl,
    pushToken: flags.pushToken.trim(),
  };
}

async function loadState(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      details: parsed && typeof parsed.details === 'object' && !Array.isArray(parsed.details) ? parsed.details : {},
      seen: parsed && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen) ? parsed.seen : {},
    };
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[rss-bridge] 读取状态文件失败，使用空状态: ${err.message}`);
    }
    return { details: {}, seen: {} };
  }
}

function pruneDetails(details) {
  const entries = Object.entries(details);
  if (entries.length <= MAX_DETAILS_CACHE) return details;
  entries.sort((a, b) => (b[1]?.fetchedAt || 0) - (a[1]?.fetchedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_DETAILS_CACHE));
}

function saveState(stateFile, state) {
  state.details = pruneDetails(state.details);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(stateFile), { recursive: true });
      const tmpFile = `${stateFile}.tmp`;
      await writeFile(tmpFile, content, 'utf8');
      await rename(tmpFile, stateFile);
    });
  return writeQueue;
}

function decodeXmlEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|#39);/g, (full, entity) => {
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

function stripCdata(raw) {
  return String(raw || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

function extractTag(block, tag) {
  const rx = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = rx.exec(block);
  if (!match) return '';
  const inner = match[1];
  if (/<!\[CDATA\[/.test(inner)) return stripCdata(inner);
  return decodeXmlEntities(inner).trim();
}

function parseRssItems(xml, limit, feedUrl) {
  const firstItemIdx = xml.search(/<item\b/i);
  const channelHeader = firstItemIdx >= 0 ? xml.slice(0, firstItemIdx) : xml;
  const fallbackOrigin = new URL(feedUrl).origin;
  const channel = {
    title: extractTag(channelHeader, 'title') || new URL(feedUrl).hostname,
    link: extractTag(channelHeader, 'link') || fallbackOrigin,
    description: extractTag(channelHeader, 'description') || 'Trimmed HLS RSS Relay',
  };

  const items = [];
  const itemRx = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
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
    if (!guid || !pageUrl) continue;
    items.push({ guid, title: title || guid, pageUrl, pubDate, description });
    if (items.length >= limit) break;
  }

  return { channel, items };
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderRssXml(channel, items, { linkMedia = false, direct = false, publicBase = '' } = {}) {
  const ready = items.filter(item => item.m3u8Url);
  const itemXml = ready
    .map(item => {
      const enclosureUrl = direct || !publicBase ? item.m3u8Url : buildProxyM3u8Url(publicBase, item);
      const linkUrl = linkMedia ? enclosureUrl : item.pageUrl;
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

function rewriteM3u8Playlist(playlistText, upstreamUrl, id, publicBase, allowRelative = true) {
  const upstreamDir = new URL('./', upstreamUrl).href;

  const rewriteUri = rawUri => {
    const trimmed = String(rawUri || '').trim();
    if (!trimmed) return trimmed;
    let abs;
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
      return abs.href.slice(upstreamDir.length);
    }
    return `${publicBase}/hls-sub/${id}?u=${encodeURIComponent(abs.href)}`;
  };

  return String(playlistText || '')
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (/^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF):/i.test(trimmed)) {
        return trimmed.replace(/URI="([^"]+)"/gi, (_full, uri) => `URI="${rewriteUri(uri)}"`);
      }
      if (trimmed.startsWith('#')) return line;
      return rewriteUri(trimmed);
    })
    .join('\n');
}

async function fetchText(url, headers, timeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText}`);
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      const canRetry = attempt === 0 && (err?.retryable !== false);
      if (!canRetry) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastError;
}

function cleanMatchedUrl(raw) {
  return decodeXmlEntities(String(raw || '').trim()).replace(/\\+$/, '');
}

function extractM3u8FromHtml(html, pageUrl) {
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

function extractCoverFromHtml(html, pageUrl) {
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

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
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

function syncDetailsIndex(state, detailsById) {
  for (const [guid, detail] of Object.entries(state.details || {})) {
    if (detail?.m3u8Url) {
      detailsById.set(makeItemId(guid), { guid, ...detail });
    }
  }
}

async function resolveItems(rawItems, state, config, detailsById) {
  let cacheHits = 0;
  let fetched = 0;
  const failed = [];

  const resolved = await mapPool(rawItems, config.concurrency, async item => {
    const cached = state.details[item.guid];
    if (cached?.m3u8Url) {
      if (detailsById) detailsById.set(makeItemId(item.guid), { guid: item.guid, ...cached });
      cacheHits++;
      return { ...item, m3u8Url: cached.m3u8Url, cover: cached.cover || '', fromCache: true };
    }

    try {
      const html = await fetchText(
        item.pageUrl,
        {
          'user-agent': DEFAULT_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: config.referer,
        },
        config.timeout
      );
      const m3u8Url = extractM3u8FromHtml(html, item.pageUrl);
      if (!m3u8Url) {
        failed.push({ guid: item.guid, pageUrl: item.pageUrl, error: '页面未找到 .m3u8 地址' });
        return { ...item, m3u8Url: '', cover: '', fromCache: false };
      }
      const cover = extractCoverFromHtml(html, item.pageUrl);
      const detail = { m3u8Url, title: item.title, cover, fetchedAt: Date.now() };
      state.details[item.guid] = detail;
      if (detailsById) detailsById.set(makeItemId(item.guid), { guid: item.guid, ...detail });
      fetched++;
      return { ...item, m3u8Url, cover, fromCache: false };
    } catch (err) {
      failed.push({ guid: item.guid, pageUrl: item.pageUrl, error: err?.message || '抓取失败' });
      return { ...item, m3u8Url: '', cover: '', fromCache: false };
    }
  });

  return { resolved, cacheHits, fetched, failed };
}

function sanitizeFilename(title, fallbackId) {
  const cleaned = String(title || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  const base = cleaned || `video-${String(fallbackId || 'item').replace(/[^a-zA-Z0-9_-]/g, '') || Date.now()}`;
  return base.toLowerCase().endsWith('.mp4') ? base : `${base}.mp4`;
}

async function pushToDownloader(item, config) {
  const filename = sanitizeFilename(item.title, item.guid);
  const headers = { 'content-type': 'application/json' };
  if (config.pushToken) headers.authorization = config.pushToken;

  const res = await fetch(config.pushUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      list: [
        {
          url: item.m3u8Url,
          filename,
          type: 'm3u8',
          sourceUrl: item.pageUrl,
          headers: { referer: config.referer },
        },
      ],
    }),
    signal: AbortSignal.timeout(config.timeout),
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.code !== 0) {
    throw new Error(data?.message || `HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  return filename;
}

async function fetchUpstreamFeed(config, limitOverride) {
  const limit = clampInt(limitOverride, config.limit, 1, 50);
  const xml = await fetchText(
    config.feedUrl,
    { 'user-agent': DEFAULT_UA, accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
    config.timeout
  );
  return parseRssItems(xml, limit, config.feedUrl);
}

async function runPushCycle(config, state, detailsById) {
  const { items: rawItems } = await fetchUpstreamFeed(config);
  console.log(`[rss-bridge] 拉取上游 RSS 成功，截取最新 ${rawItems.length} 条 (limit=${config.limit})`);

  if (config.initOnly) {
    let added = 0;
    const now = Date.now();
    for (const item of rawItems) {
      if (!state.seen[item.guid]) {
        state.seen[item.guid] = {
          title: item.title,
          m3u8Url: state.details[item.guid]?.m3u8Url || '',
          pushedAt: now,
        };
        added++;
      }
    }
    await saveState(config.stateFile, state);
    console.log(`[rss-bridge] init-only 完成: 新增基线 ${added} 条，总已处理 ${Object.keys(state.seen).length} 条`);
    return;
  }

  const unseen = rawItems.filter(item => !state.seen[item.guid]);
  if (!unseen.length) {
    console.log('[rss-bridge] 暂无未推送的新增条目');
    return;
  }

  console.log(`[rss-bridge] 发现 ${unseen.length} 条未处理条目，开始提取 m3u8...`);
  const { resolved, cacheHits, fetched, failed } = await resolveItems(unseen, state, config, detailsById);
  const ready = resolved.filter(item => item.m3u8Url);

  if (fetched > 0) {
    await saveState(config.stateFile, state);
  }

  console.log(
    `[rss-bridge] 解析完成: 成功 ${ready.length}/${unseen.length} (缓存命中 ${cacheHits}, 新抓取 ${fetched}, 失败 ${failed.length})`
  );
  for (const err of failed) {
    console.warn(`[rss-bridge] 提取失败: ${err.pageUrl} -> ${err.error}`);
  }

  if (config.dryRun) {
    console.log('[rss-bridge] dry-run 模式：以下条目将被推送（未实际请求下载器，也未写入 seen）：');
    for (const [idx, item] of ready.entries()) {
      const m3u8Host = new URL(item.m3u8Url).host;
      console.log(`  ${idx + 1}. guid=${item.guid} | host=${m3u8Host} | file=${sanitizeFilename(item.title, item.guid)}`);
      console.log(`     page=${item.pageUrl}`);
      console.log(`     m3u8=${item.m3u8Url}`);
    }
    return;
  }

  if (!config.pushUrl) {
    throw new Error('执行推送需要指定 --push-url (例如 http://127.0.0.1:6600/api/download)，或使用 --dry-run / --init-only');
  }

  let pushed = 0;
  for (const item of ready) {
    try {
      const filename = await pushToDownloader(item, config);
      state.seen[item.guid] = { title: item.title, m3u8Url: item.m3u8Url, pushedAt: Date.now() };
      await saveState(config.stateFile, state);
      pushed++;
      console.log(`[rss-bridge] 已推送 (${pushed}/${ready.length}): ${filename}`);
    } catch (err) {
      console.error(`[rss-bridge] 推送失败 (${item.guid}): ${err?.message || err}`);
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function resolvePublicBase(req, config) {
  if (config.publicUrl) return config.publicUrl;
  const fallbackHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return `http://${req.headers.host || `${fallbackHost}:${config.port}`}`;
}

function upstreamHeaders(config, req) {
  const headers = {
    'user-agent': DEFAULT_UA,
    referer: config.referer,
    origin: new URL(config.referer).origin,
  };
  if (req?.headers?.range) {
    headers.range = String(req.headers.range);
  }
  return headers;
}

async function proxyHlsTarget({ req, res, targetUrl, isPlaylist, allowRelative = true, id, publicBase, config }) {
  if (isPlaylist) {
    const text = await fetchText(targetUrl, upstreamHeaders(config, null), config.timeout);
    const rewritten = rewriteM3u8Playlist(text, targetUrl, id, publicBase, allowRelative);
    const len = Buffer.byteLength(rewritten, 'utf8');
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'content-length': String(len),
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? '' : rewritten);
    return;
  }

  const abortController = new AbortController();
  const timeoutMs = Math.max(config.timeout, 60000);
  const timer = setTimeout(() => abortController.abort(new Error('Upstream segment timeout')), timeoutMs);
  const onClientClose = () => {
    if (!res.writableFinished) abortController.abort();
  };
  res.on('close', onClientClose);

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders(config, req),
      redirect: 'follow',
      signal: abortController.signal,
    });
    const outHeaders = { 'cache-control': 'no-store' };
    for (const key of PROXY_SAFE_HEADERS) {
      const value = upstreamRes.headers.get(key);
      if (value !== null) outHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, outHeaders);
    if (req.method === 'HEAD' || !upstreamRes.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstreamRes.body), res);
  } catch (err) {
    if (abortController.signal.aborted && res.headersSent) return;
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: err?.message || '上游媒体代理失败' });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } finally {
    clearTimeout(timer);
    res.removeListener('close', onClientClose);
  }
}

function startServer(config, state, detailsById, getOrRefreshFeed) {
  const server = createServer(async (req, res) => {
    const publicBase = resolvePublicBase(req, config);
    const rawPathname = String(req.url || '/').split('?')[0];
    const reqUrl = new URL(req.url || '/', publicBase);
    const path = reqUrl.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    if (/^\/hls\/[0-9a-f]{16}\//i.test(rawPathname)) {
      const rawTail = rawPathname.slice('/hls/'.length + 17);
      let decodedTail = rawTail;
      try {
        decodedTail = decodeURIComponent(rawTail);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid path encoding' });
        return;
      }
      if (
        rawTail.includes('\\') ||
        decodedTail.includes('\\') ||
        rawTail.split('/').some(seg => seg === '..' || /^%2e%2e$/i.test(seg)) ||
        decodedTail.split('/').some(seg => seg === '..')
      ) {
        sendJson(res, 400, { ok: false, error: 'Invalid path' });
        return;
      }
    }

    if (path === '/health') {
      const snapshot = getOrRefreshFeed.peek();
      sendJson(res, 200, {
        ok: true,
        feedUrl: config.feedUrl,
        limit: config.limit,
        cachedDetails: Object.keys(state.details).length,
        indexedStreams: detailsById.size,
        seenCount: Object.keys(state.seen).length,
        lastRefreshAt: snapshot?.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : null,
      });
      return;
    }

    const hlsMatch = /^\/hls\/([0-9a-f]{16})\/(.+)$/i.exec(path);
    if (hlsMatch) {
      const id = hlsMatch[1].toLowerCase();
      const entry = detailsById.get(id);
      if (!entry?.m3u8Url) {
        sendJson(res, 404, { ok: false, error: 'Stream not found' });
        return;
      }
      const rawRel = hlsMatch[2];
      let relPath;
      try {
        relPath = decodeURIComponent(rawRel);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid path encoding' });
        return;
      }
      if (
        !relPath ||
        relPath.startsWith('/') ||
        relPath.includes('\\') ||
        rawRel.split('/').some(seg => seg === '..') ||
        relPath.split('/').some(seg => seg === '..')
      ) {
        sendJson(res, 400, { ok: false, error: 'Invalid path' });
        return;
      }
      const isPlaylist = relPath.toLowerCase().endsWith('.m3u8');
      let targetUrl = entry.m3u8Url;
      if (!isPlaylist) {
        let resolvedTarget;
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
      try {
        await proxyHlsTarget({ req, res, targetUrl, isPlaylist, id, publicBase, config });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: err?.message || '上游代理失败' });
      }
      return;
    }

    const subMatch = /^\/hls-sub\/([0-9a-f]{16})$/i.exec(path);
    if (subMatch) {
      const id = subMatch[1].toLowerCase();
      const entry = detailsById.get(id);
      if (!entry?.m3u8Url) {
        sendJson(res, 404, { ok: false, error: 'Stream not found' });
        return;
      }
      const rawTarget = reqUrl.searchParams.get('u') || '';
      let target;
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
      try {
        await proxyHlsTarget({ req, res, targetUrl: target.href, isPlaylist, allowRelative: false, id, publicBase, config });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: err?.message || '上游代理失败' });
      }
      return;
    }

    if (path === '/items.json' || path === '/rss.xml' || path === '/') {
      try {
        const reqLimit = clampInt(reqUrl.searchParams.get('limit'), config.limit, 1, 50);
        const forceRefresh = reqUrl.searchParams.get('refresh') === '1';
        const linkMedia = config.linkMedia || reqUrl.searchParams.get('link') === 'media';
        const direct = config.direct || reqUrl.searchParams.get('direct') === '1';
        const data = await getOrRefreshFeed(reqLimit, forceRefresh);
        const items = data.items.slice(0, reqLimit);

        if (path === '/items.json') {
          sendJson(res, 200, {
            ok: true,
            channel: data.channel,
            fetchedAt: new Date(data.fetchedAt).toISOString(),
            count: items.filter(it => it.m3u8Url).length,
            failedCount: data.failedCount,
            items: items.map(it => ({
              guid: it.guid,
              title: it.title,
              pageUrl: it.pageUrl,
              m3u8Url: it.m3u8Url,
              proxyM3u8Url: it.m3u8Url ? buildProxyM3u8Url(publicBase, it) : '',
              cover: it.cover,
              pubDate: it.pubDate,
              referer: config.referer,
            })),
          });
          return;
        }

        const xml = renderRssXml(data.channel, items, { linkMedia, direct, publicBase });
        res.writeHead(200, {
          'content-type': 'application/rss+xml; charset=utf-8',
          'cache-control': `public, max-age=${config.cacheTtl}`,
        });
        res.end(req.method === 'HEAD' ? '' : xml);
        return;
      } catch (err) {
        sendJson(res, 502, { ok: false, error: err?.message || '上游拉取失败' });
        return;
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  });

  return new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', rejectReady);
      console.log(`[rss-bridge] RSS 中转服务已启动: http://${config.host}:${config.port}/rss.xml`);
      resolveReady(server);
    });
  });
}

async function main() {
  const config = parseConfig();
  if (config.help) {
    printHelp();
    return;
  }

  if (config.watch && !config.serve && !config.pushUrl && !config.dryRun && !config.initOnly) {
    throw new Error('--watch 模式下请提供 --push-url (或同时启用 --serve / --dry-run)');
  }

  const state = await loadState(config.stateFile);
  const detailsById = new Map();
  syncDetailsIndex(state, detailsById);

  let cachedFeed = null;
  let inflightRefresh = null;

  const refreshFeed = async (targetLimit, forceRefresh) => {
    const now = Date.now();
    const ttlMs = config.cacheTtl * 1000;
    const isFresh = cachedFeed && now - cachedFeed.fetchedAt < ttlMs && cachedFeed.requestedLimit >= targetLimit;
    if (!forceRefresh && isFresh) return cachedFeed;
    if (inflightRefresh) return inflightRefresh;

    const effectiveLimit = Math.max(config.limit, targetLimit);
    inflightRefresh = (async () => {
      const { channel, items: rawItems } = await fetchUpstreamFeed(config, effectiveLimit);
      const { resolved, fetched, failed } = await resolveItems(rawItems, state, config, detailsById);
      if (fetched > 0) await saveState(config.stateFile, state);
      cachedFeed = {
        channel,
        items: resolved,
        failedCount: failed.length,
        requestedLimit: effectiveLimit,
        fetchedAt: Date.now(),
      };
      return cachedFeed;
    })();

    try {
      return await inflightRefresh;
    } finally {
      inflightRefresh = null;
    }
  };
  refreshFeed.peek = () => cachedFeed;

  if (config.once) {
    await runPushCycle(config, state, detailsById);
    return;
  }

  let server = null;
  let watchTimer = null;

  if (config.serve) {
    server = await startServer(config, state, detailsById, refreshFeed);
  }

  if (config.watch) {
    const runWatchTick = async () => {
      try {
        if (config.pushUrl || config.dryRun || config.initOnly) {
          await runPushCycle(config, state, detailsById);
        } else {
          const data = await refreshFeed(config.limit, true);
          console.log(`[rss-bridge] 定时刷新 RSS 缓存完成: ${data.items.filter(it => it.m3u8Url).length} 条可用`);
        }
      } catch (err) {
        console.error(`[rss-bridge] 定时任务执行异常: ${err?.message || err}`);
      }
    };

    await runWatchTick();
    watchTimer = setInterval(() => {
      void runWatchTick();
    }, config.intervalMinutes * 60 * 1000);
    console.log(`[rss-bridge] 定时轮询已开启，每 ${config.intervalMinutes} 分钟检查一次`);
  }

  const shutdown = () => {
    if (watchTimer) clearInterval(watchTimer);
    if (server) {
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 3000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`[rss-bridge] 错误: ${err?.message || err}`);
  process.exit(1);
});

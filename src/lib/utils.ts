import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { M3u8ByteRange } from '../types/m3u8.js';

export const md5 = (value: string) => createHash('md5').update(value).digest('hex');
export const logger = {
  debug: (...args: unknown[]) => {
    if (process.env.DS_DEBUG === '1') console.debug(...args);
  },
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
export function formatByteSize(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][i]}`;
}
export async function checkFileExists(path?: string) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export const isOkStatus = (status?: number) => status != null && status >= 200 && status < 300;

export function normalizeDownloadUrl(value: string) {
  const clean = value.trim().replace(/\\([_,])/g, '$1');
  if (!/^https?:\/\//i.test(clean)) throw new Error('请输入以 http:// 或 https:// 开头的下载链接');
  const url = new URL(clean);
  if (url.username || url.password) throw new Error('请通过请求头填写认证信息');
  return url.href;
}
export function formatHeaders(input?: OutgoingHttpHeaders | string): OutgoingHttpHeaders {
  if (!input) return {};
  let headers: OutgoingHttpHeaders;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text.startsWith('{')) headers = JSON.parse(text);
    else {
      headers = {};
      for (const line of text.replace(/,\s*([a-zA-Z0-9_-]+:)/g, '\n$1').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const index = line.indexOf(':');
        if (index < 1) throw new Error('请求头请使用「名称: 值」格式，每行一项，或填写 JSON 对象');
        headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
    }
  } else headers = input;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('请求头必须是对象');
  const result: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim().toLowerCase();
    if (name.startsWith(':') || ['host', 'content-length', 'connection', 'accept-encoding'].includes(name)) continue;
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n]/.test(String(value))) throw new Error(`无效的请求头: ${name}`);
    if (value != null) result[name] = value;
  }
  return result;
}
export function buildRequestHeaders(url: string, input?: OutgoingHttpHeaders | string) {
  const custom = formatHeaders(input);
  const headers: OutgoingHttpHeaders = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36',
    accept: '*/*',
    referer: `${new URL(url).origin}/`,
    ...custom,
  };
  // An explicitly empty Referer disables the automatic value.
  if (!headers.referer) delete headers.referer;
  return headers;
}
export function withRangeHeader(headers: OutgoingHttpHeaders | string | undefined, range?: M3u8ByteRange) {
  if (!range?.length) return headers;
  const offset = range.offset ?? 0;
  return { ...formatHeaders(headers), range: `bytes=${offset}-${offset + range.length - 1}` };
}
export function sliceByterange(buffer: Buffer, range?: M3u8ByteRange, statusCode = 200): Buffer {
  if (!range?.length || statusCode === 206) return buffer;
  const offset = range.offset ?? 0;
  return buffer.subarray(offset, offset + range.length);
}
interface HttpResult<T> {
  url: string;
  buffer: Buffer;
  data: T;
  response: { statusCode: number; statusMessage: string; headers: IncomingHttpHeaders };
}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`HTTP ${status}: ${url}${[401, 403, 404].includes(status) ? '（请检查链接有效期、来源页 Referer 或 Cookie）' : ''}`);
  }
}
async function openStream(
  url: string,
  headers: OutgoingHttpHeaders,
  signal?: AbortSignal,
  redirects = 0,
  method: 'GET' | 'POST' = 'GET',
  body?: string
): Promise<{ url: string; response: IncomingMessage }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = (parsed.protocol === 'https:' ? https : http).request(parsed, { method, headers, signal, timeout: 30_000 }, res => {
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('远端提前关闭响应，请重试')));
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error('重定向次数过多'));
          return;
        }
        let target: URL;
        try {
          target = new URL(normalizeDownloadUrl(new URL(res.headers.location, url).href));
        } catch (error) {
          reject(error);
          return;
        }
        const forwarded = { ...headers };
        if (target.origin !== parsed.origin) {
          delete forwarded.cookie;
          delete forwarded.authorization;
        }
        const nextMethod = res.statusCode === 303 || (method === 'POST' && [301, 302].includes(res.statusCode)) ? 'GET' : method;
        if (nextMethod === 'GET') {
          delete forwarded['content-length'];
          delete forwarded['content-type'];
        }
        openStream(target.href, forwarded, signal, redirects + 1, nextMethod, nextMethod === 'GET' ? undefined : body).then(
          resolve,
          reject
        );
        return;
      }
      if (!isOkStatus(res.statusCode)) {
        res.resume();
        reject(new HttpError(res.statusCode, url));
        return;
      }
      resolve({ url, response: res });
    });
    req.once('timeout', () => req.destroy(new Error('请求超过 30 秒未响应')));
    req.once('error', reject);
    req.end(body);
  });
}
/** Unbuffered HTTP response, with the same headers, redirects, timeout and cancellation as HLS. */
export function getResponse(
  url: string,
  headers?: OutgoingHttpHeaders | string,
  signal?: AbortSignal,
  request?: { method: 'POST'; body: string }
) {
  const normalized = normalizeDownloadUrl(url);
  const outgoing = { ...buildRequestHeaders(normalized, headers), 'accept-encoding': 'identity' };
  if (request) outgoing['content-length'] = Buffer.byteLength(request.body);
  return openStream(normalized, outgoing, signal, 0, request?.method, request?.body);
}
/** Scope credentials to the page that supplied them; a Referer remains useful on its CDN. */
export function headersForTarget(source: string, target: string, input?: OutgoingHttpHeaders | string) {
  const headers = formatHeaders(input);
  if (new URL(source).origin !== new URL(target).origin) {
    delete headers.cookie;
    delete headers.authorization;
  }
  if (headers.referer === undefined) headers.referer = source;
  return headers;
}
async function requestOnce(
  url: string,
  headers: OutgoingHttpHeaders,
  signal?: AbortSignal,
  progress?: (bytes: number) => void
): Promise<HttpResult<string>> {
  const { url: finalUrl, response } = await openStream(url, headers, signal);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    progress?.(size);
    if (size > 128 * 1024 * 1024) {
      response.destroy();
      throw new Error('单个分片超过 128 MB 限制');
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return {
    url: finalUrl,
    buffer,
    data: buffer.toString('utf8'),
    response: { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: response.headers },
  };
}
export async function getRetry<T = string>(
  url: string,
  headers?: OutgoingHttpHeaders | string,
  retries = 3,
  signal?: AbortSignal,
  progress?: (bytes: number) => void
): Promise<HttpResult<T>> {
  const normalized = normalizeDownloadUrl(url);
  for (let attempt = 0; ; attempt++) {
    try {
      progress?.(0);
      return (await requestOnce(normalized, buildRequestHeaders(normalized, headers), signal, progress)) as unknown as HttpResult<T>;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= retries - 1 || (error instanceof HttpError && error.status < 500 && error.status !== 429)) throw error;
      await delay(Math.min(500 * 2 ** attempt, 3000), undefined, { signal });
    }
  }
}

import type { OutgoingHttpHeaders } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { getResponse } from '../lib/utils.js';

export interface PageRequest {
  headers?: OutgoingHttpHeaders | string;
  signal?: AbortSignal;
  maxBytes?: number;
  method?: 'GET' | 'POST';
  body?: string;
}
export interface PageData {
  url: string;
  text: string;
  contentType: string;
}
export interface ParserContext {
  signal?: AbortSignal;
  /** SDK transport override, also used by local HTTP fixture tests. */
  request?: (url: string, options?: PageRequest) => Promise<PageData>;
  resolve?: (url: string, options?: PageRequest) => Promise<string>;
}
export async function requestPage(url: string, options: PageRequest = {}): Promise<PageData> {
  const { response, url: finalUrl } = await getResponse(
    url,
    options.headers,
    options.signal,
    options.method === 'POST' ? { method: 'POST', body: options.body || '' } : undefined
  );
  const encoding = response.headers['content-encoding'];
  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'br'
        ? createBrotliDecompress()
        : encoding === 'deflate'
          ? createInflate()
          : undefined;
  const stream = decoder ? response.pipe(decoder) : response;
  const abort = () => stream.destroy(new Error('解析已取消'));
  const onError = (error: Error) => stream.destroy(error);
  if (decoder) response.once('error', onError);
  options.signal?.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    options.signal?.throwIfAborted();
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 5 * 1024 * 1024)) throw new Error('页面内容超过大小限制');
      chunks.push(chunk);
    }
    return { url: finalUrl, text: Buffer.concat(chunks).toString('utf8'), contentType: String(response.headers['content-type'] || '') };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    response.destroy();
    decoder?.destroy();
  }
}
export async function resolveLocation(url: string, options: PageRequest = {}) {
  const result = await getResponse(url, options.headers, options.signal);
  result.response.destroy();
  return result.url;
}
export const readPage = (context: ParserContext, url: string, options: PageRequest = {}) =>
  (context.request || requestPage)(url, { ...options, signal: context.signal });
export const locate = (context: ParserContext, url: string, options: PageRequest = {}) =>
  (context.resolve || resolveLocation)(url, { ...options, signal: context.signal });

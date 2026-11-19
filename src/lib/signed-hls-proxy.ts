import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { getResponse, HttpError, scopeCredentials } from './utils.js';

const authKeys = ['token', 'expires', 'token_path', 'vid'];

/** Keep downloader resource identities stable while origin credentials rotate. */
export async function signedHlsProxy(initial: string, refresh: () => Promise<string>, headers: OutgoingHttpHeaders, signal: AbortSignal) {
  let current = new URL(initial);
  const source = new URL(initial);
  const prefix = source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
  let inflight: Promise<void> | undefined;
  const expiresSoon = () => {
    const expires = current.searchParams.get('expires');
    return /^\d{10}$/.test(expires || '') && Number(expires) * 1000 < Date.now() + 5000;
  };
  const update = () => {
    inflight ??= (async () => {
      signal.throwIfAborted();
      const next = new URL(await refresh());
      signal.throwIfAborted();
      if (next.origin !== source.origin || next.pathname !== source.pathname) throw new Error('刷新后的媒体地址已变化，请重新开始下载');
      current = next;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  const credentialTarget = (resource: URL) => resource.origin === source.origin && resource.pathname.startsWith(prefix);
  const signed = (resource: URL) => {
    const result = new URL(resource);
    if (credentialTarget(resource)) {
      for (const key of authKeys) {
        const value = current.searchParams.get(key);
        if (value !== null) result.searchParams.set(key, value);
        else result.searchParams.delete(key);
      }
    }
    return result.href;
  };
  const resources = new Map<string, URL>();
  const identities = new Map<string, string>();
  const secret = randomUUID();
  let base = '';
  const register = (raw: string, parent: string) => {
    const resource = new URL(raw, parent);
    if (!['https:', 'http:'].includes(resource.protocol) || resource.username || resource.password)
      throw new Error('无效的 HLS 子资源地址');
    resource.hash = '';
    if (credentialTarget(resource)) for (const key of authKeys) resource.searchParams.delete(key);
    let id = identities.get(resource.href);
    if (!id) {
      if (resources.size >= 50_000) throw new Error('播放列表资源数超过限制');
      id = String(resources.size);
      identities.set(resource.href, id);
      resources.set(id, resource);
    }
    return `${base}/${secret}/${id}`;
  };
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const server = createServer(async (req, res) => {
    const id =
      /^\d+$/.test(req.url?.slice(secret.length + 2) || '') && req.url.startsWith(`/${secret}/`) ? req.url.slice(secret.length + 2) : '';
    const resource = resources.get(id);
    if (req.method !== 'GET' || !resource) {
      res.writeHead(404).end();
      return;
    }
    const local = new AbortController();
    res.once('close', () => local.abort());
    const upstreamSignal = AbortSignal.any([requestSignal, local.signal]);
    try {
      if (credentialTarget(resource) && expiresSoon()) await update();
      const previous = current;
      const outgoing = { ...scopeCredentials(source.href, resource.href, headers) };
      if (req.headers.range) outgoing.range = req.headers.range;
      let upstream: Awaited<ReturnType<typeof getResponse>>;
      try {
        upstream = await getResponse(signed(resource), outgoing, upstreamSignal);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 403 || !credentialTarget(resource)) throw error;
        if (current === previous) await update();
        upstream = await getResponse(signed(resource), outgoing, upstreamSignal);
      }
      const stream = upstream.response;
      const manifest = /\.m3u8$/i.test(resource.pathname) || /mpegurl/i.test(String(stream.headers['content-type']));
      res.statusCode = stream.statusCode;
      if (manifest) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            stream.destroy();
            throw new Error('播放列表超过大小限制');
          }
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('媒体响应不是有效的 HLS 播放列表');
        const rewritten = text
          .split(/\r?\n/)
          .map(line => {
            if (!line.trim()) return line;
            if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_all, uri) => `URI="${register(uri, upstream.url)}"`);
            return register(line.trim(), upstream.url);
          })
          .join('\n');
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.end(rewritten);
      } else {
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = stream.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        await pipeline(stream, res);
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(error instanceof HttpError ? error.status : 502);
      res.end('媒体请求失败，请检查来源页面和播放凭证');
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      done();
    });
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: register(initial, initial),
    identity: (url: string) => {
      const target = new URL(url);
      const resource = target.origin === base ? resources.get(target.pathname.slice(secret.length + 2)) : undefined;
      return resource?.href || url;
    },
    close: async () => {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

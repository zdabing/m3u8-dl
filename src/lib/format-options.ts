import { basename, extname, resolve } from 'node:path';
import type { M3u8DLOptions } from '../types/m3u8.js';
import { formatHeaders, md5, normalizeDownloadUrl } from './utils.js';

export async function formatOptions(input: string, opts: M3u8DLOptions = {}) {
  const url = /^https?:\/\//i.test(input) ? normalizeDownloadUrl(input) : input;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames cannot contain control characters.
  const filename = basename(opts.filename?.trim() || md5(url)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const options: M3u8DLOptions = {
    delCache: true,
    convert: true,
    ...opts,
    filename: extname(filename) ? filename : `${filename}.mp4`,
    saveDir: resolve(opts.saveDir || './downloads'),
    cacheDir: resolve(opts.cacheDir || './cache'),
    threadNum: Math.min(16, Math.max(1, Math.floor(Number(opts.threadNum) || 4))),
    headers: formatHeaders(opts.headers),
  };
  return { url, options, urlMd5: md5(url) };
}

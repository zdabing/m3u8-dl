import { basename, extname, resolve } from 'node:path';
import type { M3u8DLOptions } from '../types/m3u8.js';
import { detectPlatform, sourceUrl } from '../video-parser/platform.js';
import { formatHeaders, md5, normalizeDownloadUrl } from './utils.js';

export async function formatOptions(input: string, opts: M3u8DLOptions = {}) {
  const url =
    /^https?:\/\//i.test(input) && !/\s/.test(input.trim())
      ? normalizeDownloadUrl(input)
      : /https?:\/\//i.test(input)
        ? sourceUrl(input)
        : input;
  if (opts.type && !['auto', 'm3u8', 'file', 'parser'].includes(opts.type)) throw new Error('下载类型应为 auto、m3u8、file 或 parser');
  let remoteName = '';
  try {
    remoteName = basename(decodeURIComponent(new URL(url).pathname));
  } catch {
    /* Local HLS or encoded filename. */
  }
  const remoteExt = extname(remoteName).toLowerCase();
  const fileExtensions = [
    '.mp4',
    '.mkv',
    '.mov',
    '.m4v',
    '.avi',
    '.flv',
    '.webm',
    '.wmv',
    '.ts',
    '.m4s',
    '.mp3',
    '.wav',
    '.ogg',
    '.m4a',
    '.aac',
    '.flac',
    '.vtt',
    '.srt',
    '.ass',
    '.ssa',
  ];
  const type =
    opts.type && opts.type !== 'auto'
      ? opts.type
      : detectPlatform(url).platform !== 'unknown'
        ? 'parser'
        : fileExtensions.includes(remoteExt)
          ? 'file'
          : 'm3u8';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames cannot contain control characters.
  const invalidCharacters = /[<>:"/\\|?*\x00-\x1f]/g;
  const filename = basename(opts.filename?.trim() || (type === 'file' ? remoteName : '') || md5(url)).replace(invalidCharacters, '_');
  // Only a known media suffix counts as an extension: "1.10" or "v1.2" would otherwise ship without a suffix.
  const knownSuffixes = [...fileExtensions, '.txt'];
  const hasKnownExtension = knownSuffixes.some(suffix => filename.toLowerCase().endsWith(suffix));
  const usableRemoteExt = knownSuffixes.includes(remoteExt) ? remoteExt : '';
  const options: M3u8DLOptions = {
    delCache: true,
    convert: true,
    ...opts,
    type,
    filename: hasKnownExtension ? filename : `${filename}${type === 'file' ? usableRemoteExt || '.bin' : '.mp4'}`,
    saveDir: resolve(opts.saveDir || './downloads'),
    cacheDir: resolve(opts.cacheDir || './cache'),
    threadNum: Math.min(16, Math.max(1, Math.floor(Number(opts.threadNum) || 4))),
    headers: formatHeaders(opts.headers),
  };
  return { url, options, urlMd5: md5(url) };
}

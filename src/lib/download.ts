import type { M3u8DLOptions } from '../types/m3u8.js';
import { VideoParser } from '../video-parser/index.js';
import { fileDownload, PlaylistResponse } from './file-download.js';
import { formatOptions } from './format-options.js';
import { m3u8Download } from './m3u8-download.js';
import { formatHeaders, headersForTarget } from './utils.js';

export async function downloadResource(input: string, options: M3u8DLOptions = {}) {
  const formatted = await formatOptions(input, options);
  if (options.sourceUrl) {
    const headers = headersForTarget(options.headerSourceUrl || options.sourceUrl, formatted.url, options.headers);
    if (formatHeaders(options.headers).referer === undefined) headers.referer = options.sourceUrl;
    options = { ...options, headers };
    formatted.options.headers = options.headers;
  }
  if (formatted.options.type === 'parser') return VideoParser.download(formatted.url, options);
  if (formatted.options.type !== 'file') return m3u8Download(formatted.url, formatted.options);
  try {
    return await fileDownload(formatted.url, formatted.options);
  } catch (error) {
    // An extensionless CDN link may serve a playlist; retry it down the HLS path instead of saving text as video.
    if (!(error instanceof PlaylistResponse)) throw error;
    return m3u8Download(formatted.url, { ...formatted.options, type: 'm3u8' });
  }
}

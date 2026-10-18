import { downloadResource } from './lib/download.js';
import type { M3u8DLOptions } from './types/m3u8.js';

export async function m3u8BatchDownload(urls: string[], options: M3u8DLOptions = {}) {
  let success = true;
  for (const url of urls) {
    const result = await downloadResource(url, options);
    if (result.errmsg || result.paused) success = false;
  }
  return success;
}

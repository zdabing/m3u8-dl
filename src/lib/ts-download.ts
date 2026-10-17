import { promises as fs } from 'node:fs';
import type { OutgoingHttpHeaders } from 'node:http';
import { dirname } from 'node:path';
import type { M3u8Crypto, TsItemInfo } from '../types/m3u8.js';
import { decryptSegmentData } from './crypto.js';
import { getRetry, sliceByterange, withRangeHeader } from './utils.js';

export async function tsDownload(
  info: TsItemInfo,
  crypto?: M3u8Crypto,
  headers?: OutgoingHttpHeaders | string,
  signal?: AbortSignal,
  progress?: (bytes: number) => void
) {
  signal?.throwIfAborted();
  try {
    const stat = await fs.stat(info.tsOut);
    if (stat.size > 0) {
      info.tsSize = stat.size;
      return true;
    }
  } catch {
    /* Not cached. */
  }
  const r = await getRetry(info.uri, withRangeHeader(headers, info.byterange), 3, signal, progress);
  const data = decryptSegmentData(sliceByterange(r.buffer, info.byterange, r.response.statusCode), crypto);
  if (!data.length) throw new Error(`视频分片为空: ${info.index + 1}`);
  await fs.mkdir(dirname(info.tsOut), { recursive: true });
  const temporary = `${info.tsOut}.part`;
  try {
    await fs.writeFile(temporary, data, { signal });
    signal?.throwIfAborted();
    await fs.rename(temporary, info.tsOut);
    info.tsSize = data.length;
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

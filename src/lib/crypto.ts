import { createDecipheriv } from 'node:crypto';
import type { M3u8Crypto } from '../types/m3u8.js';

export function decryptSegmentData<T extends Buffer | Uint8Array>(data: T, info?: M3u8Crypto): Buffer {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!info?.key) return buffer;
  if (info.method.toUpperCase() !== 'AES-128') throw new Error(`暂不支持 ${info.method} 加密的视频`);
  const decipher = createDecipheriv(
    'aes-128-cbc',
    info.key as NodeJS.ArrayBufferView,
    (info.iv || new Uint8Array(16)) as NodeJS.ArrayBufferView
  );
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

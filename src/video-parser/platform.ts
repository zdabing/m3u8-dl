import { normalizeDownloadUrl } from '../lib/utils.js';

export function sourceUrl(input: string) {
  if (typeof input !== 'string') throw new Error('请填写有效的网页或分享链接');
  const text = input.trim();
  if (/^https?:\/\//i.test(text) && !/[\s<>"'，。！？、）]/.test(text)) return normalizeDownloadUrl(text);
  const match = /https?:\/\/[^\s<>"'，。！？、）]+/i.exec(text);
  if (!match) throw new Error('请填写 http/https 链接，或包含链接的分享文本');
  return normalizeDownloadUrl(match[0].replace(/[)\]，。；;]+$/, ''));
}
export function detectPlatform(input: string) {
  try {
    const url = sourceUrl(input);
    const host = new URL(url).hostname.toLowerCase();
    const domains = { douyin: ['douyin.com', 'iesdouyin.com'], weibo: ['weibo.com', 'weibo.cn', 't.cn'], pipixia: ['pipix.com'] };
    for (const [platform, list] of Object.entries(domains))
      if (list.some(domain => host === domain || host.endsWith(`.${domain}`))) return { url, platform };
    return { url, platform: 'unknown' };
  } catch (error) {
    return { url: '', platform: 'unknown', errmsg: (error as Error).message };
  }
}

import type { OutgoingHttpHeaders } from 'node:http';
import { decodePageText } from '../../lib/getM3u8Urls.js';
import { formatHeaders, normalizeDownloadUrl } from '../../lib/utils.js';
import { type ParserContext, readPage } from '../request.js';
import { BaseParser } from './base-parser.js';

export class JavrateParser extends BaseParser {
  public static override async parse(url: string, headers?: OutgoingHttpHeaders | string, context: ParserContext = {}) {
    try {
      const source = new URL(url);
      const outgoing = { referer: source.origin + '/', ...formatHeaders(headers) };
      const page = await readPage(context, url, { headers: outgoing });
      const title = decodePageText(/<title[^>]*>([^<]*)<\/title>/i.exec(page.text)?.[1] || '').trim();
      const iframe = /<iframe\b[^>]*\bsrc=["']([^"']*\/player\/[^"']*)["']/i.exec(page.text)?.[1];
      const playerUrl = iframe ? normalizeDownloadUrl(new URL(decodePageText(iframe), page.url).href) : page.url;
      if (new URL(playerUrl).origin !== source.origin) throw new Error('播放器来源已变化，请重新检查站点结构');
      const player = iframe ? await readPage(context, playerUrl, { headers: { ...outgoing, referer: page.url } }) : page;
      const text = decodePageText(player.text);
      let media = /https?:\/\/[^\s"'<>\\]+\.m3u8\?[^\s"'<>\\]+/i.exec(text)?.[0];
      if (!media) {
        const raw = /"contentUrl"\s*:\s*"([^"\r\n]+)"/i.exec(page.text)?.[1];
        if (!raw) throw new Error('未找到播放地址，页面可能需要运行播放器脚本或完成验证');
        const bare = normalizeDownloadUrl(decodePageText(raw));
        const issued = await readPage(context, source.origin + '/api/bunnytoken/generate', {
          method: 'POST',
          headers: { ...outgoing, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ m3u8Url: bare }),
        });
        const result = JSON.parse(issued.text);
        media = result.success && result.data?.signedUrl;
        if (typeof media !== 'string' || !media) throw new Error('站点未返回有效播放凭证');
      }
      const target = new URL(normalizeDownloadUrl(media));
      if (!target.searchParams.has('token')) throw new Error('站点未返回带 token 的播放地址');
      if (!['avking.xyz', 'b-cdn.net'].some(domain => target.hostname.endsWith('.' + domain))) {
        throw new Error('媒体来源已变化，请重新检查站点结构');
      }
      return JavrateParser.success({ url: target.href, title, referer: playerUrl, platform: 'javrate' });
    } catch (error) {
      context.signal?.throwIfAborted();
      return JavrateParser.error(`Javrate 解析失败：${(error as Error).message}`);
    }
  }
}

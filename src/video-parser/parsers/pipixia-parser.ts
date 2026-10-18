import type { OutgoingHttpHeaders } from 'node:http';
import { formatHeaders, normalizeDownloadUrl } from '../../lib/utils.js';
import { locate, type ParserContext, readPage } from '../request.js';
import { BaseParser } from './base-parser.js';

export class PipixiaParser extends BaseParser {
  public static override async parse(url: string, headers?: OutgoingHttpHeaders | string, context: ParserContext = {}) {
    try {
      const outgoing = { referer: 'https://www.pipix.com/', ...formatHeaders(headers) };
      const location = await locate(context, url, { headers: outgoing });
      const id = /\/item\/(\d+)/.exec(new URL(location).pathname)?.[1];
      if (!id) return PipixiaParser.error('无法解析皮皮虾视频 ID，请检查分享链接');
      const page = await readPage(context, `https://h5.pipix.com/bds/cell/cell_h5_comment/?cell_id=${id}&aid=1319&app_name=super`, {
        headers: outgoing,
      });
      const data = JSON.parse(page.text);
      const item = data.data?.cell_comments?.[0]?.comment_info?.item || data.data?.item || data.data?.cell_data?.item;
      const video = item?.video;
      const address = (video?.video_high || video?.video_mid || video?.video_low)?.url_list?.[0];
      const media = typeof address === 'string' ? address : address?.url;
      if (!media) return PipixiaParser.error('皮皮虾未返回视频数据，内容可能已失效、需要 Cookie 或接口已变化');
      return PipixiaParser.success({
        url: normalizeDownloadUrl(media),
        title: item.content || '',
        platform: 'pipixia',
        referer: location,
        author: item.author?.name,
        uid: String(item.author?.uid || ''),
        like: item.digg_count,
        time: item.create_time,
        avatar: item.author?.avatar?.url_list?.[0]?.url,
        cover: item.cover?.url_list?.[0]?.url,
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      return PipixiaParser.error(`皮皮虾解析失败：${(error as Error).message}`);
    }
  }
}

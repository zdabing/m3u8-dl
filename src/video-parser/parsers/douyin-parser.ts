import type { OutgoingHttpHeaders } from 'node:http';
import { formatHeaders, normalizeDownloadUrl } from '../../lib/utils.js';
import { locate, type ParserContext, readPage } from '../request.js';
import { BaseParser } from './base-parser.js';

interface Address {
  uri?: string;
  url_list?: string[];
  urlList?: string[];
}
interface DouyinItem {
  desc?: string;
  video: { play_addr?: Address; playAddr?: Address; cover?: { url_list?: string[] } };
  author?: { nickname?: string; unique_id?: string; avatar_medium?: { url_list?: string[] } };
  statistics?: { digg_count?: number };
  create_time?: number;
}

export class DouyinParser extends BaseParser {
  public static override async parse(url: string, headers?: OutgoingHttpHeaders | string, context: ParserContext = {}) {
    try {
      const outgoing = {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1',
        ...formatHeaders(headers),
      };
      const location = await locate(context, url, { headers: outgoing });
      const parsed = new URL(location);
      const id = /\/(?:video|note|slides)\/(\d+)/.exec(parsed.pathname)?.[1] || parsed.searchParams.get('modal_id');
      if (!id || !/^\d+$/.test(id)) return DouyinParser.error('无法解析抖音视频 ID，请检查分享链接');
      const page = await readPage(context, `https://www.iesdouyin.com/share/video/${id}`, { headers: outgoing });
      const router = /window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/i.exec(page.text)?.[1]?.trim().replace(/;\s*$/, '');
      const render = /<script\b[^>]*id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i.exec(page.text)?.[1];
      if (!router && !render) return DouyinParser.error('抖音页面未返回视频数据，可能需要有效 Cookie，或平台页面结构已变化');
      const data = JSON.parse(router || decodeURIComponent(render));
      const queue: unknown[] = [data];
      let item: DouyinItem;
      for (let count = 0; queue.length && count < 3000; count++) {
        const node = queue.shift() as DouyinItem;
        if (!node || typeof node !== 'object') continue;
        if (node.video?.play_addr || node.video?.playAddr) {
          item = node;
          break;
        }
        queue.push(...Object.values(node));
      }
      const address = item?.video?.play_addr || item?.video?.playAddr;
      if (!address) return DouyinParser.error('抖音页面未返回可用视频，可能是图文、内容限制、需要 Cookie 或平台接口变化');
      const uri = address.uri;
      let media =
        uri && !/^https?:/i.test(uri)
          ? `https://www.iesdouyin.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=1080p&line=0`
          : address.url_list?.[0] || address.urlList?.[0] || uri;
      if (!media) return DouyinParser.error('抖音未返回可下载的视频地址');
      media = normalizeDownloadUrl(media.replace('/playwm/', '/play/'));
      media = await locate(context, media, { headers: { 'user-agent': outgoing['user-agent'], referer: location } });
      return DouyinParser.success({
        url: media,
        title: item.desc || '',
        platform: 'douyin',
        referer: location,
        author: item.author?.nickname,
        uid: item.author?.unique_id,
        avatar: item.author?.avatar_medium?.url_list?.[0],
        cover: item.video.cover?.url_list?.[0],
        like: item.statistics?.digg_count,
        time: item.create_time,
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      return DouyinParser.error(`抖音解析失败：${(error as Error).message}`);
    }
  }
}

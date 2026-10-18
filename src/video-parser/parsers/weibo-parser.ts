import type { OutgoingHttpHeaders } from 'node:http';
import { formatHeaders, normalizeDownloadUrl } from '../../lib/utils.js';
import { locate, type ParserContext, readPage } from '../request.js';
import { BaseParser } from './base-parser.js';

interface WeiboItem {
  title?: string;
  text?: string;
  urls?: Record<string, string>;
  author?: string;
  author_id?: string | number;
  avatar?: string;
  cover_image?: string;
  like_count?: number;
  attitudes_count?: number;
  user?: { screen_name?: string; id?: number; avatar_hd?: string };
  page_info?: { title?: string; page_pic?: { url?: string }; media_info?: { stream_url_hd?: string; stream_url?: string } };
}

export class WeiboParser extends BaseParser {
  public static override async parse(url: string, headers?: OutgoingHttpHeaders | string, context: ParserContext = {}) {
    try {
      const outgoing = { referer: 'https://weibo.com/', ...formatHeaders(headers) };
      if (!outgoing.cookie) return WeiboParser.error('微博解析需要 Cookie，请在请求头中填写有效的微博 Cookie');
      const location = new URL(url).hostname === 't.cn' ? await locate(context, url, { headers: outgoing }) : url;
      const parsed = new URL(location);
      const oid = parsed.searchParams.get('fid') || /\d+:\d+/.exec(parsed.pathname)?.[0];
      let item: WeiboItem;
      let media: string;
      if (oid && /^\d+:\d+$/.test(oid)) {
        const page = await readPage(context, `https://weibo.com/tv/api/component?page=${encodeURIComponent(`/tv/show/${oid}`)}`, {
          method: 'POST',
          headers: { ...outgoing, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: JSON.stringify({ Component_Play_Playinfo: { oid } }) }).toString(),
        });
        const data = JSON.parse(page.text);
        item = data.data?.Component_Play_Playinfo;
        const entries = Object.entries(item?.urls || {}) as [string, string][];
        entries.sort((a, b) => Number(/\d{3,4}/.exec(b[0])?.[0] || 0) - Number(/\d{3,4}/.exec(a[0])?.[0] || 0));
        media = entries[0]?.[1];
      } else {
        const id = /\/(?:status|detail)\/([\w]+)/.exec(parsed.pathname)?.[1] || /^\/\d+\/([\w]+)\/?$/.exec(parsed.pathname)?.[1];
        if (!id) return WeiboParser.error('无法解析微博视频 ID，请使用视频分享链接或微博正文链接');
        const page = await readPage(context, `https://m.weibo.cn/statuses/show?id=${encodeURIComponent(id)}`, { headers: outgoing });
        const data = JSON.parse(page.text);
        item = data.data;
        media = item?.page_info?.media_info?.stream_url_hd || item?.page_info?.media_info?.stream_url;
      }
      if (!media || typeof media !== 'string') return WeiboParser.error('微博未返回可下载视频，请检查 Cookie、内容权限或平台接口变化');
      return WeiboParser.success({
        url: normalizeDownloadUrl(new URL(media, 'https://weibo.com/').href),
        title: item.title || item.page_info?.title || String(item.text || '').replace(/<[^>]+>/g, ''),
        platform: 'weibo',
        referer: location,
        author: item.author || item.user?.screen_name,
        uid: String(item.author_id || item.user?.id || ''),
        cover: item.cover_image || item.page_info?.page_pic?.url,
        avatar: item.avatar || item.user?.avatar_hd,
        like: item.like_count || item.attitudes_count,
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      return WeiboParser.error(`微博解析失败：${(error as Error).message}`);
    }
  }
}

import type { OutgoingHttpHeaders } from 'node:http';
import type { ApiResponse, VideoInfo } from '../../types/contract.js';
import type { ParserContext } from '../request.js';

export abstract class BaseParser {
  protected static success(data: VideoInfo): ApiResponse<VideoInfo> {
    return { code: 0, data };
  }
  protected static error(message: string): ApiResponse<VideoInfo> {
    return { code: 1, message };
  }
  public static async parse(
    _url: string,
    _headers?: OutgoingHttpHeaders | string,
    _context?: ParserContext
  ): Promise<ApiResponse<VideoInfo>> {
    return { code: 1, message: '不支持的视频平台' };
  }
}

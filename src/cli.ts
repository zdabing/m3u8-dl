import { program } from 'commander';
import { m3u8BatchDownload } from './m3u8-batch-download.js';
import type { M3u8DLOptions } from './types/m3u8.js';

program.name('m3u8dl').description('M3U8 下载与无损合并、视频及字幕直链下载').version('1.10.0');
program
  .argument('[urls...]', 'M3U8、视频/字幕直链，或抖音、微博、皮皮虾分享链接')
  .option('-T, --type <type>', '下载类型：auto、m3u8、file、parser', 'auto')
  .option('-f, --filename <name>', '保存文件名')
  .option('-S, --save-dir <dir>', '保存目录', './downloads')
  .option('-C, --cache-dir <dir>', '分片缓存目录', './cache')
  .option('-n, --thread-num <number>', '并发分片数', value => Number(value), 4)
  .option('-H, --headers <headers>', '请求头：每行名称: 值或 JSON')
  .option('--no-del-cache', '合并成功后保留分片缓存')
  .option('--ffmpeg-path <path>', 'FFmpeg 可执行文件路径')
  .action(async (urls: string[], options: M3u8DLOptions) => {
    if (!urls.length) {
      program.help();
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    try {
      process.exitCode = (await m3u8BatchDownload(urls, { ...options, signal: controller.signal })) ? 0 : 1;
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    }
  });
program
  .command('extract')
  .description('从网页或平台分享链接提取媒体地址，输出 JSON')
  .argument('<urls...>', '网页或分享链接，每次最多 20 个')
  .option('-d, --depth <depth>', '子页面搜索深度（0–3）', value => Number(value), 1)
  .option('--path-filter <text>', '仅搜索地址包含该文本的站内链接')
  .option('-H, --headers <headers>', '来源网页请求头或平台 Cookie')
  .action(async (urls: string[], options: { depth: number; pathFilter?: string; headers?: string }) => {
    const { extractMedia } = await import('./lib/getM3u8Urls.js');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const result = await extractMedia({
      url: urls[0],
      urls,
      deep: options.depth,
      headers: options.headers,
      pathFilter: options.pathFilter,
      signal: controller.signal,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.items.length) process.exitCode = 1;
  });
program
  .command('server')
  .description('启动 Web 下载器')
  .option('-P, --port <port>', '服务端口', value => Number(value), 6600)
  .option('-t, --token <token>', '访问密码')
  .action(async (options: { port: number; token?: string }) => {
    const { DLServer } = await import('./server/download-server.js');
    const server = new DLServer(options);
    await server.ready;
    process.once('SIGINT', () => {
      void server.close();
    });
    process.once('SIGTERM', () => {
      void server.close();
    });
  });
void program.parseAsync().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

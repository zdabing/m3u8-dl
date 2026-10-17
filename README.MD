# M3U8 下载器（精简版）

只保留 M3U8/HLS 下载、断点续传、无损合并和手机 WebUI。没有内置播放器、网页浏览器、平台视频解析、搜索、AriaNg、油猴脚本或 Electron 打包。基于 [lzwme/m3u8-dl](https://github.com/lzwme/m3u8-dl) 精简。

## 运行

需要 Node.js 22.12+、pnpm；推荐安装 FFmpeg 并加入 PATH。没有 FFmpeg 时 MPEG-TS 顺序合并为 `.ts`，fMP4 拼接初始化段和分片为 `.mp4`。

```sh
pnpm install
pnpm build
pnpm start
```

打开 `http://localhost:6600`。手机连接同一网络后，用运行电脑的局域网 IP 加端口访问。文件保存在服务器；已完成任务的“保存文件”可把成品下载到手机。

`pnpm dev` 启动 SDK 编译、后端和 Vite 开发页面；首次运行应先执行 `pnpm build:cjs`。

## 请求头

默认对播放列表、密钥、初始化段和媒体分片发送浏览器 User-Agent、`Accept: */*` 和资源域名的 Referer。支持 `.txt`、`.woff2` 等伪装后缀。会清理复制 Markdown 链接时混入的反斜杠，不依赖后缀识别 HLS。

在“来源与请求头”填写真实播放页面 Referer，或填写 Cookie / User-Agent。支持 JSON 对象及每行 `名称: 值`；请求头名称大小写不敏感。单任务覆盖默认设置，默认设置覆盖自动值。显式空 Referer 可关闭自动值。请求头写入服务器配置/任务记录；访问密码仅保留在浏览器会话。

失败任务可编辑请求头后继续，完整下载的分片会复用。HTTP 错误保留具体状态；403/404 提示检查有效期、Referer 和 Cookie。单个网络请求在 30 秒无响应后中断。

## 命令行

```sh
node bin/m3u8dl.js 'https://example.com/index.m3u8' -f video -S ./downloads
node bin/m3u8dl.js 'https://example.com/index.txt' -H 'Referer: https://example.com/watch'
node bin/m3u8dl.js server -P 6600 -t your-password
```

Ctrl+C 中止任务，保留分片。选项见 `node bin/m3u8dl.js --help`。SDK 导出 `m3u8Download`、`m3u8BatchDownload`、`parseM3U8`、`m3u8Convert`；取消使用 `AbortSignal` 或 `m3u8DLStop(url)`。

## 下载列表与分片详情

界面参考 [M3U8Quicker](https://github.com/Liubsyy/M3U8Quicker) 的紧凑列表：文件名、进度、实时速度、状态和操作集中展示，手机上自动改为卡片。点分片数量或详情图标，可查看编号色块、状态筛选、尝试次数和单个错误；每页最多渲染 100 个分片。

速度和字节数在分片接收期间每 500 毫秒更新，不必等整个分片完成。分片详情打开时每秒读取最新记录。

失败任务提供“仅重试失败分片”。该模式校验播放列表指纹，只请求失败的媒体分片，复用成功缓存；若播放列表变化、成功缓存缺失或没有旧记录，会明确提示改用“继续下载”。普通继续也会复用成功缓存。合并失败但媒体已齐全时，继续会直接重新合并。

## 合并

流式读取分片、使用背压送入 FFmpeg，不再逐个分片重复分析，不把整部视频读入内存。TS 头部修复在流式读取时完成，原缓存不被修改。FFmpeg 通过无 shell 的参数数组启动，不阻塞事件循环；实时报告合并进度。

一次只运行一个合并进程，其余任务排队；下载可以并发。默认连续 180 秒无进展会中止，可在设置里调整到 15–3600 秒。暂停会终止合并进程。只有成功结束且非空的文件才重命名为成品；错误、超时和暂停保留分片。合并失败不会被当作成功。

## 数据与配置

默认任务/配置在 `~/.m3u8-dl/cache`，视频在 `./downloads`。旧任务记录会读取，运行中及排队任务在重启后转为暂停。

环境变量：`DS_PORT`、`DS_SAVE_DIR`、`DS_CACHE_DIR`、`DS_SECRET`、`DS_FFMPEG_PATH`、`DS_PROXY_MODE`、`DS_PROXY_URL`、`DS_NO_PROXY`。代理支持系统环境变量、自定义 HTTP 代理和禁用。

## 验证

```sh
pnpm test        # 本地 HTTP + FFmpeg 集成测试，缺 FFmpeg 时媒体测试跳过
pnpm lint:all
pnpm typecheck
pnpm build
```

测试覆盖请求头、跨域重定向、HTTP 错误、请求取消、TS/fMP4/AES-128、断点续传、合并超时和取消、失败产物清理及服务鉴权，不依赖外部视频站点。

## Docker

```sh
docker compose -f docker/docker-compose.yml up --build -d
```

镜像只包含运行依赖、WebUI、SDK 和 FFmpeg。MIT 许可证，见 LICENSE。

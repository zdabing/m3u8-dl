# M3U8 下载器（精简版）

支持 M3U8/HLS 下载、视频与字幕直链下载、平台分享链接解析、网页媒体提取、断点续传、无损合并和手机 WebUI。没有内置播放器、网页浏览器、搜索站、AriaNg、油猴脚本或 Electron 打包。基于 [lzwme/m3u8-dl](https://github.com/lzwme/m3u8-dl) 改造。

## 运行

需要 Node.js 22.12+、pnpm；推荐安装 FFmpeg 并加入 PATH。没有 FFmpeg 时 MPEG-TS 顺序合并为 `.ts`，fMP4 拼接初始化段和分片为 `.mp4`。

```sh
pnpm install
pnpm build
pnpm start
```

打开 `http://localhost:6600`。手机连接同一网络后，用运行电脑的局域网 IP 加端口访问。文件保存在服务器；已完成任务的“保存文件”可把成品下载到手机。

`pnpm dev` 启动 SDK 编译、后端和 Vite 开发页面；首次运行应先执行 `pnpm build:cjs`。

## 视频与字幕直链

新建下载支持混合粘贴 M3U8、MP4、VTT 等链接。自动模式识别支持的平台分享链接，并根据 URL 路径后缀识别常见视频、音频和字幕文件（包括 MP4、MKV、WebM、MP3、VTT、SRT、ASS）；其余按 M3U8 处理，`.txt` 等伪装播放列表仍可使用。没有后缀的文件直链请选择“普通文件直链”；伪装成 `.mp4` 等媒体后缀的播放列表请选择“M3U8”。普通播放网页请使用“网页提取”。

普通文件按原始字节流式落盘，不经过 FFmpeg，也不会把 VTT 改成 MP4。支持同样的请求头、下载队列、进度、暂停、重试、批量操作和完成后保存文件。VTT 单独保存，不自动合并进视频。暂停和失败保留临时文件；服务器支持 Range 且提供 ETag 或 Last-Modified 时可校验后续传，不支持时从头下载。服务器忽略续传范围或文件已更新时会重新下载，只有完整文件才发布为成品。

## 平台解析与网页提取

- **平台分享链接**：支持抖音、微博、皮皮虾，自动识别平台并解析视频地址，可粘贴含链接的分享文本。抖音使用原有的非水印播放地址，其他平台优先采用返回的视频地址。微博需要在请求头中填写有效 Cookie。内容失效、登录限制或接口变化会返回明确错误，不能保证每条链接都能解析或无水印。
- **网页提取**：点击顶部“网页提取”，一行填写一个播放页或分享链接，每次最多 20 个。支持页面里的 M3U8、MP4、VTT 等媒体地址、相对路径、HTML/JSON 转义地址、视频/source/track 标签及 iframe 子页。
- **深度搜索**：可设 0–3 层，并按子页面路径文本筛选。站内链接按层搜索，iframe 可跨来源；每次最多读取 30 页、提取 100 个结果，单页解压后最多 5 MB，总计最多 60 秒。不会执行远程 JavaScript，因此只在脚本运行后才出现的地址可能提取不到。
- **批量下载**：提取结果支持全选或勾选后加入队列；带上对应来源页 Referer，跨来源下载和子页面访问不转发来源页的 Cookie/Authorization。弹窗关闭或取消提取会中止请求。部分页面失败时保留其他已找到的结果并显示失败原因。

SDK 恢复 `VideoParser.parse/download/getPlatform/getSupportedPlatforms`、`getM3u8Urls`，另提供结构化 `extractMedia`；服务端提供鉴权后的 `/api/extract`、`/api/parse`、`/api/platforms`，并保留旧 `/api/getM3u8Urls` 返回格式。

## 请求头

默认对播放列表、密钥、初始化段和媒体分片发送浏览器 User-Agent、`Accept: */*` 和资源域名的 Referer。支持 `.txt`、`.woff2` 等伪装后缀。会清理复制 Markdown 链接时混入的反斜杠，不依赖后缀识别 HLS。

在“来源与请求头”填写真实播放页面 Referer，或填写 Cookie / User-Agent。支持 JSON 对象及每行 `名称: 值`；请求头名称大小写不敏感。单任务覆盖默认设置，默认设置覆盖自动值。显式空 Referer 可关闭自动值。请求头写入服务器配置/任务记录；访问密码仅保留在浏览器会话。

失败任务可编辑请求头后继续，完整下载的分片会复用。HTTP 错误保留具体状态；403/404 提示检查有效期、Referer 和 Cookie。单个网络请求在 30 秒无响应后中断。

## 命令行

```sh
node bin/m3u8dl.js 'https://example.com/index.m3u8' -f video -S ./downloads
node bin/m3u8dl.js 'https://example.com/index.txt' -H 'Referer: https://example.com/watch'
node bin/m3u8dl.js 'https://example.com/video.mp4'
node bin/m3u8dl.js 'https://example.com/zh.vtt'
node bin/m3u8dl.js 'https://example.com/download?id=123' -T file -f video.mp4
node bin/m3u8dl.js 'https://www.douyin.com/video/123456789'
node bin/m3u8dl.js extract 'https://example.com/watch/123' --depth 2 --path-filter /play/
node bin/m3u8dl.js server -P 6600 -t your-password
```

Ctrl+C 中止任务，保留下载缓存。`-T auto|m3u8|file|parser` 指定类型。`extract` 命令输出包含地址、标题、来源页和错误信息的 JSON，不自动下载。选项见 `node bin/m3u8dl.js --help`。SDK 导出自动分流的 `downloadResource`、普通文件 `fileDownload`、HLS 专用 `m3u8Download`，以及支持混合链接的 `m3u8BatchDownload`、`parseM3U8`、`m3u8Convert`；取消使用 `AbortSignal` 或 `m3u8DLStop(url)`（同时支持普通文件与平台分享链接）。

## 下载列表与分片详情

界面参考 [M3U8Quicker](https://github.com/Liubsyy/M3U8Quicker) 的紧凑列表：文件名、进度、实时速度、状态和操作集中展示，手机上自动改为卡片。点分片数量或详情图标，可查看编号色块、状态筛选、尝试次数和单个错误；每页最多渲染 100 个分片。

速度和字节数在分片接收期间每 500 毫秒更新，不必等整个分片完成。分片详情打开时每秒读取最新记录。

每行任务支持勾选，可全选当前分类和搜索结果中的任务，批量继续 / 重试、暂停、仅重试失败分片或移除；切换分类和搜索时会取消不在当前列表中的选择。已完成列表也可批量移除。移除前会列出所选任务并确认是否清理分片缓存、是否同时删除合并文件；合并文件默认保留。手机端同样支持多选和批量操作。

界面保留白蓝配色，按任务名称、进度、速度和状态分层展示；顶部显示连接状态和总速度。勾选后，全局操作会切换为所选任务的批量工具栏，并显示可继续或暂停的任务数量；手机端工具栏会随滚动保持可见。新建、提取、设置和移除弹窗统一布局，手机上以底部面板打开，表单内容独立滚动、确认按钮固定在底部。支持键盘焦点、方向键切换分类和减少动态效果设置。

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

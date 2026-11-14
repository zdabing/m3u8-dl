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

普通文件请求若返回 HLS 的 Content-Type，会自动切换到播放列表下载；CLI、SDK、WebUI 和平台解析入口均适用，并保留来源页请求头、取消信号和缓存归属。未正确标注 Content-Type 的伪装播放列表仍可手动选择“M3U8”。

成品旁的隐藏完成标记按输出路径记录当前来源和文件身份，仅在匹配且无残留下载临时文件时跳过下载。同名文件被替换后，旧标记失效；新标记通过临时文件原子提交。缺失、损坏或旧版标记不作为完成凭据，会重新下载。失败时保留缓存和原有成品，不发布未完成文件。

## 平台解析与网页提取

- **平台分享链接**：支持抖音、微博、皮皮虾，自动识别平台并解析视频地址，可粘贴含链接的分享文本。抖音使用原有的非水印播放地址，其他平台优先采用返回的视频地址。微博需要在请求头中填写有效 Cookie。内容失效、登录限制或接口变化会返回明确错误，不能保证每条链接都能解析或无水印。
- **网页提取**：点击顶部“网页提取”，一行填写一个播放页或分享链接，每次最多 20 个。支持页面里的 M3U8、MP4、VTT 等媒体地址、相对路径、HTML/JSON 转义地址、视频/source/track 标签及 iframe 子页。
- **深度搜索**：可设 0–3 层，并按子页面路径文本筛选。站内链接按层搜索，iframe 可跨来源；每次最多读取 30 页、提取 100 个结果，单页解压后最多 5 MB，单页请求最多 60 秒。不会执行远程 JavaScript，因此只在脚本运行后才出现的地址可能提取不到。
- **批量下载**：提取结果支持全选或勾选后加入队列；带上对应来源页 Referer，跨来源下载和子页面访问不转发来源页的 Cookie/Authorization。弹窗关闭或取消提取会中止请求。部分页面失败时保留其他已找到的结果并显示失败原因。站点返回 Cloudflare 验证页时会单独提示，可改用来源方提供的下载链接。

SDK 恢复 `VideoParser.parse/download/getPlatform/getSupportedPlatforms`、`getM3u8Urls`，另提供结构化 `extractMedia`；服务端提供鉴权后的 `/api/extract`、`/api/parse`、`/api/platforms`，并保留旧 `/api/getM3u8Urls` 返回格式。

## 浏览器保存

Docker 镜像包含下载器和浏览器。启用后，在下载器中选择「浏览器保存」，粘贴播放页、创建任务，再打开浏览器窗口从头播放。下载器保存浏览器已收到的分片，在任务列表显示进度，并在收齐后自动合并。暂停或关闭播放页会保留已写入的分片；重新开始需从头播放。

播放页和媒体域名需加入 `DS_BROWSER_ORIGINS`。支持带结束标记、未加密、音视频在同一流内的 MPEG-TS HLS。切换清晰度或快进跳过分片可能导致任务无法合并。直播、独立音轨、字幕、fMP4 和加密流可按各自适用的普通下载流程处理。

在 `docker` 目录的 `.env` 中设置 `DS_SECRET`（下载器密码）、`DS_BROWSER_VNC_PASSWORD`（8 位英文字母或数字）和 `DS_BROWSER_ORIGINS`（逗号分隔的来源，如 `https://player.example.com,https://media.example.com`），然后拉取镜像并启动：

```sh
docker compose pull
docker compose up -d
```

也可以用 `docker compose up -d --build` 从源码构建。`DS_BROWSER_ORIGINS` 留空时只启动下载器。浏览器窗口默认只在宿主机通过 `http://localhost:6080/vnc.html` 打开。手机端可在私有网络中通过带身份验证的 HTTPS 反向代理访问此窗口，并把 `DS_BROWSER_WINDOW` 设为手机可打开的完整 noVNC URL。反向代理需支持 WebSocket；若代理运行在其他主机，`DS_BROWSER_BIND` 应设为代理可访问的宿主机地址。浏览器控制端口 `9323` 只监听容器内部回环地址。

## 请求头

### 手机从猫抓发送到 Docker

猫抓无需修改源码。先在 Docker 环境中设置访问密码 `DS_SECRET`，并构建新版。使用仓库的 Compose 文件时，可在运行命令的目录下用 `.env` 设置 `DS_SECRET=你的访问密码`，或在部署平台的环境变量中设置。

在猫抓「发送数据」中启用「手动发送」，选择 `POST` 和 JSON，然后填写：

- **地址**：手机能访问的下载器地址加 `/api/cat-catch`，例如 `http://192.168.1.10:6600/api/cat-catch`。用宿主机对手机开放的端口；`localhost` 指手机自己。
- **请求头**：`{"Authorization":"你的下载器访问密码"}`。使用密码原值，不加 `Bearer`。这是下载器的密码，和媒体请求的 Cookie 无关。
- **请求体**：`{"action":"${action}","data":${data}}`，也兼容猫抓自带的、额外包含 `tabId` 的默认模板。

播放视频并按需开启字幕后，在猫抓中选中媒体或字幕，点击发送即可入队。支持单条、逐条和合并发送，已完成或正在排队/下载的同一链接会跳过；失败任务可用新捕获的请求头重新发送。会保留捕获到的 Referer、Origin、Cookie 和 User-Agent；未捕获到的 Cookie 和 Origin 不会补填，也不继承下载器全局请求头。HLS 清单、分片、初始化段和密钥请求都不会把 Cookie 或 Authorization 发给不同来源。仅向你自己的下载器发送，外网访问使用 HTTPS。

### 手动填写

默认对播放列表、密钥、初始化段和媒体分片发送浏览器 User-Agent、`Accept: */*` 和资源域名的 Referer。支持 `.txt`、`.woff2` 等伪装后缀。会清理复制 Markdown 链接时混入的反斜杠，不依赖后缀识别 HLS。

在“来源与请求头”填写真实播放页面 Referer，或填写 Cookie / User-Agent。支持 JSON 对象及每行 `名称: 值`；请求头名称大小写不敏感。单任务覆盖默认设置，默认设置覆盖自动值。显式空 Referer 可关闭自动值。请求头写入服务器配置/任务记录；访问密码仅保留在浏览器会话。

失败任务可编辑请求头后继续，完整下载的分片会复用。HTTP 错误显示状态码和资源路径，省略查询参数。遇到 401、403 或 404 时，如果签名链接的 `expires`（或与 `t` 配对的 `e`）已到期，界面会提示重新获取完整链接；其他情况会提示检查有效期、Referer 和 Cookie。收到这类 HTTP 错误的分片只请求一次。单个网络请求在 30 秒无响应后中断。

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

# M3U8 下载器

支持电脑和手机访问的媒体下载器，基于 [lzwme/m3u8-dl](https://github.com/lzwme/m3u8-dl) 改造。

- M3U8 / HLS 下载、AES-128 解密和 FFmpeg 合并。
- MP4 等视频、MP3 / M4A / AAC / WAV / FLAC / OGG / Opus 等音频、VTT / SRT 等字幕直链下载。
- 网页媒体提取和部分平台分享链接解析。
- 批量下载、暂停续传、失败重试和任务管理。
- 脚本猫发送媒体链接、请求信息、页面名称和详情页地址。
- 提供 WebUI、CLI 和 SDK。

## Docker 运行

在仓库根目录创建 `.env`，设置访问密码：

```dotenv
DS_SECRET=你的访问密码
```

```sh
docker compose -f docker/docker-compose.yml up --build -d
```

打开 `http://服务器IP:6600`。下载文件保存在 `docker/downloads`，任务和缓存保存在 `docker/cache`。已完成文件可通过页面保存到电脑或手机。

## 内置 RSS 中转服务（多订阅源）

服务端内置了多订阅源 RSS 中转与 HLS Referer 流式代理（默认关闭，支持在 Docker 下 24 小时随服务一起运行）：

- **启用/关闭开关**：可在页面主导航「系统设置 → 网络与 RSS」中随时开启并增删多个订阅源，或通过 Docker 环境变量 `DS_RSS_BRIDGE_ENABLED=true` 默认启用。
- **双来源模式**：每个订阅源支持选择 **上游 RSS (XML)** 或 **公开列表页 (HTML)**，并可配置链接筛选词（如 `/v/`、`/watch/`）、独立 `Referer`、保留条数（`0` 表示不限制、拉取上游全部条目，超出 20 条时自动按需懒解析详情页）和缓存时长。
- **独立订阅地址**：每个订阅源生成专属地址 `http://服务器IP:6600/rss-bridge/feeds/<源ID>.xml`（兼容保留默认地址 `/rss-bridge/rss.xml`）；若设置了 `DS_SECRET`，需追加 `?token=你的DS_SECRET`。
- **能力说明**：自动抽取详情页 `.m3u8` 写入 `<enclosure>`，并在代理 `.m3u8`、密钥和分片时按订阅源隔离并补齐上游所需 `Referer`。

## 本地运行

需要 Node.js 22.12+、pnpm 和 FFmpeg。

```sh
pnpm install
pnpm build
pnpm start
```

访问 `http://localhost:6600`。默认下载目录为 `./downloads`。若启用了 `DS_SECRET`，登录弹窗默认勾选“在此浏览器记住登录状态”，同一浏览器下次打开免重复输入，也可在「系统设置 → 外观与主题」退出登录。

## 使用

WebUI 同时适配电脑端与手机端（移动端提供底部导航栏与抽屉弹窗）。点击「新建下载」，粘贴媒体链接即可，多条链接每行一个。播放页使用「网页提取」；需要登录或校验来源的资源，可填写 Cookie、Referer 等请求头。

使用脚本猫时，先在页面点击「脚本猫脚本 / 安装脚本猫脚本」。刷新播放页后打开右下角可上下拖动的「下载」悬浮按钮（已配好服务端地址时在 WebUI 本页自动隐藏；手机端以底部抽屉展示），配置下载器地址和 `DS_SECRET`，播放视频、开启字幕，勾选资源发送。名称和详情页地址可修改。

支持识别文件名在下载参数中的无后缀 MP4；「重新扫描」会检查已请求的资源，也可展开「手动添加媒体地址」粘贴直链。

脚本猫按媒体地址读取获授权的 Cookie，不能完整替代扩展级网络抓包。目前不支持脚本猫持续续签，短时效链接可能过期。平台解析和网页提取能否成功取决于来源站点；字幕单独保存。

## 命令行

```sh
node bin/m3u8dl.js 'https://example.com/video.m3u8' -f video
node bin/m3u8dl.js 'https://example.com/video.mp4'
node bin/m3u8dl.js 'https://example.com/zh.vtt'
node bin/m3u8dl.js --help
```

开发：`pnpm dev`。检查：`pnpm test`、`pnpm lint:all`、`pnpm typecheck`。

MIT 许可证，见 [LICENSE](LICENSE)。

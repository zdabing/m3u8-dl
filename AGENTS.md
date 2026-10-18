# AGENTS.md

本仓库为 M3U8/HLS 与媒体直链下载工具。保留 CLI、SDK、WebUI、服务端，并恢复平台分享链接解析和网页媒体地址提取；不要重新引入播放器、搜索站、内嵌网页浏览器、AriaNg、Electron 或外部 CDN。

## 命令

使用 pnpm。`pnpm install` 安装两个 workspace（核心与 packages/frontend）。`pnpm build` 清理产物、编译 SDK、构建 WebUI。`pnpm build:cjs` 在修改 src 后必须执行，CLI/服务器加载 cjs 产物。`pnpm start` 启动 6600 端口；`pnpm dev` 启动 SDK watch、server watch 与 Vite。

`pnpm test` 编译后使用 node:test，通过本地 HTTP 与真实 FFmpeg 验证下载、加密、续传、取消和合并；FFmpeg 缺失时媒体测试会跳过。`pnpm lint:all` 为两端 Biome；`pnpm typecheck` 包括 vue-tsc；`pnpm build` 验证生产构建。前端启用 Biome 完整 Vue 支持，不能把仅在模板使用的变量视为未使用。

## 架构

- src/lib/utils.ts：请求头归一化、自动 Referer/User-Agent、HTTP 超时重试/重定向与取消。手动请求头优先；空 Referer 禁用自动值。HTTP 状态错误不能吞掉。
- parseM3u8.ts：M3U8、EXT-X-MAP、字节范围与 AES 密钥。落盘前完成解密；AES-128 没有显式 IV 时按媒体序号推导。
- m3u8-download.ts：有上限的异步下载任务，不使用 worker_threads。暂停通过 AbortSignal，缓存仅在成功合并后清理。
- download.ts / file-download.ts：统一分流 HLS 与普通文件直链。普通文件流式落盘，续传必须校验 Range 和 ETag / Last-Modified；不支持或不匹配时重下，只有完整文件才发布。不经 FFmpeg，不把字幕改成视频后缀。
- video-parser/ 与 lib/getM3u8Urls.ts：平台解析和有深度、页面数、大小及超时限制的网页提取。仅解析页面/JSON，不执行远程脚本；跨来源媒体和子页面不得转发 Cookie/Authorization。平台接口变化应给出明确错误，不保证所有分享链接可用。
- m3u8-convert.ts / merge-process.ts：流式输入 FFmpeg、单合并队列、进度和无进展超时。禁止同步执行 FFmpeg、整文件读取视频、把失败半成品发布为完成。进程结束、流结束、取消与临时文件清理均须覆盖，合并锁必须在 finally 释放。
- server/download-server.ts：持久化、有限并发队列、REST 与 WebSocket。暂停/移除后等待任务终止，避免旧回调覆盖新任务。
- packages/frontend/src：App.vue、AppIcon.vue 和普通 CSS；不使用 Pinia、Router、Tailwind 或字体 CDN。移动端输入、按钮与弹窗需要实测。
- src/types/contract.ts：唯一前后端数据契约，只定义纯数据，不导入 Node 或后端实现。

相对 import 使用 .js 扩展名。格式为单引号、分号、2 空格、LF。修改功能后更新中文文档。

## CodeGraph

仅当根目录存在 `.codegraph/` 时，在代码搜索前优先使用 `codegraph explore`；没有该目录则跳过。
